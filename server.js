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

// WhatsApp Webhook - DEBUGGED VERSION
app.post('/webhook/whatsapp', async (req, res) => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📥 WEBHOOK RECEIVED');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Full request body:', JSON.stringify(req.body, null, 2));
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  try {
    const message = req.body.Body;
    const phone = req.body.From?.replace('whatsapp:', '');
    
    console.log('📱 Extracted Message:', message);
    console.log('📞 Extracted Phone:', phone);
    
    if (!message || !phone) {
      console.log('❌ VALIDATION FAILED: Missing message or phone');
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Error: mensaje o teléfono faltante');
      console.log('📤 Sending error response');
      return res.type('text/xml').send(twiml.toString());
    }
    
    // Find tenant - try multiple phone formats
    console.log('\n🔍 SEARCHING FOR TENANT');
    console.log('Original phone:', phone);
    
    const phoneVariations = [
      phone,
      phone.replace('+52', ''),
      '+52' + phone.replace(/^\+?52/, ''),
      phone.replace(/\D/g, ''), // Remove all non-digits
      '+' + phone.replace(/\D/g, '') // Add + to digits only
    ];
    
    console.log('Phone variations to try:', phoneVariations);
    
    let tenant = null;
    for (const p of phoneVariations) {
      console.log(`  Trying phone format: "${p}"`);
      const { data, error } = await supabase
        .from('tenants')
        .select('*, properties (*)')
        .eq('phone', p)
        .single();
      
      if (error) {
        console.log(`    ❌ Error: ${error.message}`);
      }
      if (data) { 
        tenant = data; 
        console.log(`    ✅ FOUND! Tenant: ${tenant.name}`);
        break; 
      } else {
        console.log(`    ⚠️  No match`);
      }
    }
    
    if (!tenant) {
      console.log('\n❌ TENANT NOT FOUND');
      console.log('💡 Fetching all tenants from database to debug...\n');
      
      const { data: allTenants } = await supabase
        .from('tenants')
        .select('name, phone');
      
      console.log('All tenants in database:');
      allTenants?.forEach(t => console.log(`  - ${t.name}: "${t.phone}"`));
      
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Disculpa, no encuentro tu número registrado. Por favor contacta a tu casero.');
      console.log('\n📤 Sending "not found" response');
      return res.type('text/xml').send(twiml.toString());
    }
    
    console.log('\n✅ TENANT FOUND:', {
      name: tenant.name,
      phone: tenant.phone,
      property: tenant.properties?.address
    });
    
    // Get AI response
    console.log('\n🤖 GENERATING AI RESPONSE');
    let aiReply = 'Recibí tu mensaje, te respondo en breve.';
    let needsAttention = true;
    let category = 'CONSULTA';
    
    try {
      const prompt = `Eres un asistente de administración de propiedades profesional pero cercano. Tu objetivo es resolver problemas de manera eficiente y diplomática.

TONO Y ESTILO:
- Conversacional pero profesional - hablas como un administrador experimentado y confiable
- Asertivo y claro - das respuestas directas sin rodeos innecesarios
- Diplomático - manejas situaciones delicadas con tacto
- Informal pero respetuoso - tuteas pero mantienes cortesía
- Sin jerga excesiva - usa español natural y claro

INFORMACIÓN DE LA PROPIEDAD:
Inquilino: ${tenant.name}
Dirección: ${tenant.properties?.address || 'la propiedad'}
Renta mensual: $${tenant.properties?.monthly_rent || 'N/A'} MXN
Día de pago: ${tenant.properties?.rent_due_day || 'N/A'}
Propietario: ${tenant.properties?.landlord_name || 'el propietario'}
Notas especiales: ${tenant.properties?.special_instructions || 'Sin instrucciones especiales'}

MENSAJE DEL INQUILINO: "${message}"

Responde ÚNICAMENTE con un objeto JSON (sin markdown, sin comillas extras):
{"message":"tu respuesta conversacional, asertiva y diplomática","category":"URGENTE|MANTENIMIENTO|PAGO|CONSULTA","needsAttention":true/false}`;

      console.log('Calling OpenAI...');
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { 
            role: 'system', 
            content: 'Eres un asistente profesional de administración de propiedades. Respondes de manera conversacional, asertiva, diplomática e informal pero siempre profesional. Usas español natural de México.' 
          },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7
      });
      
      const parsed = JSON.parse(completion.choices[0].message.content);
      aiReply = parsed.message;
      needsAttention = parsed.needsAttention;
      category = parsed.category;
      
      console.log('✅ AI Response generated:', {
        category,
        needsAttention,
        reply: aiReply.substring(0, 50) + '...'
      });
      
    } catch (e) {
      console.log('❌ AI Error:', e.message);
      console.log('Using fallback response');
      
      // Professional fallback responses
      const lower = message.toLowerCase();
      
      if (lower.includes('pago') || lower.includes('pagar') || lower.includes('renta') || lower.includes('cuanto')) {
        aiReply = `Tu pago vence el día ${tenant.properties?.rent_due_day || '1'} de cada mes. El monto es de $${tenant.properties?.monthly_rent || '30,000'} MXN.`;
        needsAttention = false;
        category = 'PAGO';
      } else if (lower.includes('fuga') || lower.includes('emergencia') || lower.includes('incendio') || lower.includes('gas')) {
        aiReply = 'Entendido, es urgente. Ya estoy contactando al técnico correspondiente.';
        needsAttention = true;
        category = 'URGENTE';
      } else {
        aiReply = 'Recibí tu mensaje. ¿Podrías darme más detalles para ayudarte mejor?';
        needsAttention = false;
        category = 'CONSULTA';
      }
    }
    
    // Save incoming message
    console.log('\n💾 SAVING MESSAGE TO DATABASE');
    const { error: dbError } = await supabase.from('messages').insert({
      tenant_id: tenant.id,
      direction: 'incoming',
      message_body: message,
      category,
      ai_response: aiReply,
      needs_landlord_attention: needsAttention
    });
    
    if (dbError) {
      console.log('❌ Database save error:', dbError);
    } else {
      console.log('✅ Message saved');
    }
    
    // Send reply to tenant
    console.log('\n📤 SENDING TWIML RESPONSE');
    console.log('Response:', aiReply);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiReply);
    const twimlString = twiml.toString();
    console.log('TwiML:', twimlString);
    
    res.type('text/xml').send(twimlString);
    console.log('✅ Response sent successfully\n');
    
    // Send follow-up for urgent issues
    if (needsAttention) {
      console.log('⏱️  Scheduling follow-up message in 10 seconds...');
      setTimeout(async () => {
        try {
          let followUpMessage = '';
          const lower = message.toLowerCase();
          let professional = 'el técnico';
          let professionalName = 'Rosendo';
          let timeSlot = '10:00 am';
          
          if (lower.includes('fuga') || lower.includes('agua') || lower.includes('tubería') || lower.includes('baño')) {
            professional = 'el plomero';
            professionalName = 'Rosendo';
            timeSlot = '10:00 am';
          } else if (lower.includes('luz') || lower.includes('eléctric')) {
            professional = 'el electricista';
            professionalName = 'Miguel';
            timeSlot = '2:00 pm';
          }
          
          if (category === 'URGENTE' || category === 'MANTENIMIENTO') {
            followUpMessage = `Listo, ya hablé con ${professional}. Está disponible a las ${timeSlot} y pasará a revisar. Su nombre es ${professionalName}. Me cuentas cómo va todo, y no te preocupes, yo me encargo de pagarle.`;
          }
          
          if (followUpMessage) {
            console.log('📤 Sending follow-up:', followUpMessage);
            await twilioClient.messages.create({
              from: process.env.TWILIO_WHATSAPP_NUMBER,
              to: `whatsapp:${phone}`,
              body: followUpMessage
            });
            
            await supabase.from('messages').insert({
              tenant_id: tenant.id,
              direction: 'outgoing',
              message_body: followUpMessage,
              category: category,
              ai_response: null,
              needs_landlord_attention: false
            });
            console.log('✅ Follow-up sent');
          }
        } catch (e) {
          console.error('❌ Error sending follow-up:', e);
        }
      }, 10000);
    }
    
  } catch (e) {
    console.error('\n❌❌❌ WEBHOOK ERROR ❌❌❌');
    console.error('Error:', e);
    console.error('Stack:', e.stack);
    
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('Disculpa, hubo un error. Por favor intenta de nuevo en un momento.');
    res.type('text/xml').send(twiml.toString());
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 SERVER RUNNING ON PORT', process.env.PORT || 3000);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});