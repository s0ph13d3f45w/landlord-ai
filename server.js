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
      // ✅ IMPROVED PROMPT - Natural, conversational, Mexican Spanish
      const prompt = `Eres un asistente virtual MUY amigable y natural para inquilinos en México. 

IMPORTANTE: 
- Habla como un mexicano real, de manera casual y amigable
- NO uses emojis innecesarios ni formateo especial
- NO repitas el mensaje del usuario
- Responde DIRECTAMENTE a la pregunta
- Sé breve (máximo 2-3 oraciones)
- Si puedes resolver la duda, resuélvela - NO digas solo "te respondo pronto"

DATOS DEL INQUILINO:
- Nombre: ${tenant.name}
- Propiedad: ${tenant.properties?.address || 'N/A'}
- Renta mensual: $${tenant.properties?.monthly_rent || 'N/A'} MXN
- Día de vencimiento: día ${tenant.properties?.rent_due_day || 'N/A'} de cada mes
- Casero: ${tenant.properties?.landlord_name || 'N/A'}
- Instrucciones especiales: ${tenant.properties?.special_instructions || 'Ninguna'}

MENSAJE DEL INQUILINO: "${message}"

REGLAS PARA needsAttention:
- Si es sobre PAGOS, FECHAS, REGLAS de la casa → needsAttention: false (puedes responder directamente)
- Si es EMERGENCIA real (fuga grave, incendio, robo) → needsAttention: true
- Si necesita REPARACIÓN física → needsAttention: true
- Si es pregunta sobre PERMITIR algo nuevo (mascotas, visitas largas) → needsAttention: true

CATEGORÍAS:
- URGENTE: Solo emergencias de seguridad/salud
- MANTENIMIENTO: Reparaciones o fallas
- PAGO: Preguntas sobre renta, pagos, transferencias
- CONSULTA: Preguntas generales, reglas, dudas

EJEMPLOS DE RESPUESTAS NATURALES:
❌ MAL: "🚨 X101: Hola, cuando tengo que pagar"
✅ BIEN: "Hola! Tu renta de $30,000 vence el día 1 de cada mes. ¿Necesitas los datos para transferencia?"

❌ MAL: "Recibí tu mensaje. Te respondo pronto."
✅ BIEN: "Claro! Puedes tener mascotas pequeñas, solo avísale a tu casero antes. Te contacto con él para confirmar los detalles."

❌ MAL: "Inquilino: Juan..."
✅ BIEN: Solo responde naturalmente sin repetir info

Responde SOLO en este formato JSON (sin markdown, sin \`\`\`):
{"message":"tu respuesta natural y directa","category":"URGENTE|MANTENIMIENTO|PAGO|CONSULTA","needsAttention":true o false}`;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Eres un asistente amigable que habla español mexicano natural. Respondes en JSON sin markdown.' },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.8
      });
      
      const parsed = JSON.parse(completion.choices[0].message.content);
      aiReply = parsed.message;
      needsAttention = parsed.needsAttention;
      category = parsed.category;
    } catch (e) {
      console.error('AI error:', e);
      
      // Smart fallback based on keywords
      const lower = message.toLowerCase();
      
      if (lower.includes('pago') || lower.includes('pagar') || lower.includes('renta') || lower.includes('cuanto')) {
        aiReply = `Hola! Tu renta es de $${tenant.properties?.monthly_rent || 'N/A'} y vence el día ${tenant.properties?.rent_due_day || 'N/A'} de cada mes. ¿Necesitas los datos de transferencia?`;
        needsAttention = false;
        category = 'PAGO';
      } else if (lower.includes('fuga') || lower.includes('emergencia') || lower.includes('incendio')) {
        aiReply = 'Ya le avisé a tu casero sobre esto. Te contactará lo antes posible.';
        needsAttention = true;
        category = 'URGENTE';
      } else if (lower.includes('mascota') || lower.includes('perro') || lower.includes('gato')) {
        aiReply = 'Déjame preguntarle a tu casero sobre las mascotas y te confirmo!';
        needsAttention = true;
        category = 'CONSULTA';
      } else {
        aiReply = 'Recibí tu mensaje, déjame verificar y te respondo en breve.';
        needsAttention = true;
        category = 'CONSULTA';
      }
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
        body: `🚨 ATENCIÓN REQUERIDA\n\nInquilino: ${tenant.name}\nPropiedad: ${tenant.properties.address}\n\nMensaje: "${message}"\n\nResponde directo: ${tenant.phone}`
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