require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const twilio = require('twilio');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Initialize
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.set('view engine', 'ejs');
app.set('views', './views');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true }
}));

// Test endpoint
app.get('/test', async (req, res) => {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Say: OpenAI works!' }]
    });
    res.send('✅ ' + response.choices[0].message.content);
  } catch (e) {
    res.status(500).send('❌ ' + e.message);
  }
});

// Routes
const initAuthRoutes = require('./routes/auth');
const initDashboardRoutes = require('./routes/dashboard');
const initPasswordResetRoutes = require('./routes/password-reset');

app.use('/', initAuthRoutes(supabase));
app.use('/', initDashboardRoutes(supabase, twilioClient));
app.use('/', initPasswordResetRoutes(supabase));

app.get('/', (req, res) => {
  req.session.landlordId ? res.redirect('/dashboard') : res.redirect('/login');
});

// WhatsApp Webhook
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const message = req.body.Body;
    const phone = req.body.From?.replace('whatsapp:', '');
    
    if (!message || !phone) {
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Error');
      return res.type('text/xml').send(twiml.toString());
    }
    
    // Find tenant
    let tenant = null;
    for (const p of [phone, phone.replace('+52', ''), '+52' + phone.replace(/^\+?52/, '')]) {
      const { data } = await supabase.from('tenants').select('*, properties (*)').eq('phone', p).single();
      if (data) { tenant = data; break; }
    }
    
    if (!tenant) {
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Lo siento, no reconozco este número.');
      return res.type('text/xml').send(twiml.toString());
    }
    
    // Get AI response
    let aiReply = 'Recibí tu mensaje.';
    let needsAttention = true;
    let category = 'CONSULTA';
    
    try {
      const prompt = `Responde en JSON: {"message":"tu respuesta","category":"URGENTE|MANTENIMIENTO|PAGO|CONSULTA","needsAttention":true/false}

Inquilino: ${tenant.name}
Renta: $${tenant.properties?.monthly_rent} el día ${tenant.properties?.rent_due_day}
Mensaje: "${message}"`;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      });
      
      const parsed = JSON.parse(completion.choices[0].message.content);
      aiReply = parsed.message;
      needsAttention = parsed.needsAttention;
      category = parsed.category;
    } catch (e) {
      console.error('AI error:', e);
    }
    
    // Save
    await supabase.from('messages').insert({
      tenant_id: tenant.id,
      direction: 'incoming',
      message_body: message,
      category,
      ai_response: aiReply,
      needs_landlord_attention: needsAttention
    });
    
    // Notify if urgent
    if (needsAttention && tenant.properties?.landlord_phone) {
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: `whatsapp:${tenant.properties.landlord_phone}`,
        body: `🚨 ${tenant.name}: "${message}"`
      });
    }
    
    // Reply
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiReply);
    res.type('text/xml').send(twiml.toString());
    
  } catch (e) {
    console.error('Webhook error:', e);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('Error.');
    res.type('text/xml').send(twiml.toString());
  }
});

app.listen(process.env.PORT || 3000, () => console.log('🚀 Server running'));
