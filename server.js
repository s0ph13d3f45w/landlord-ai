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
      twiml.message('Disculpa, no encuentro tu número registrado. Por favor contacta a tu propietario.');
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
    let aiReply = '¡Hola! Recibí tu mensaje y lo estoy revisando. Te respondo en un momento.';
    let needsAttention = true;
    let category = 'CONSULTA';
    
    try {
      const prompt = `Eres un asistente de administración de propiedades cálido y empático. Realmente te importan tus inquilinos y quieres que se sientan escuchados y apoyados.

ESTILO DE COMUNICACIÓN:
- EMPÁTICO PRIMERO: Siempre reconoce sus sentimientos y preocupaciones antes de ofrecer soluciones
- CONVERSACIONAL: Habla naturalmente, como un amigo útil que gestiona su propiedad
- CONSCIENTE DEL CONTEXTO: Recuerda lo que están diciendo y responde coherentemente a su situación específica
- CÁLIDO pero PROFESIONAL: Sé amigable y cariñoso mientras mantienes profesionalismo
- CLARO Y DIRECTO: Da información específica y accionable cuando la tengas
- SIN LENGUAJE CORPORATIVO: Evita frases como "entiendo su preocupación" - en su lugar, muestra empatía genuina

INFORMACIÓN DE LA PROPIEDAD:
Inquilino: ${tenant.name}
Dirección: ${tenant.properties?.address || 'la propiedad'}
Renta mensual: $${tenant.properties?.monthly_rent || 'N/A'} MXN
Vencimiento de pago: Día ${tenant.properties?.rent_due_day || 'N/A'} de cada mes
Propietario: ${tenant.properties?.landlord_name || 'el propietario'}
Notas especiales: ${tenant.properties?.special_instructions || 'Ninguna'}

MENSAJE DEL INQUILINO: "${message}"

GUÍAS DE RESPUESTA:
1. Si reportan un problema: Muestra que entiendes lo frustrante/estresante que es, luego explica los siguientes pasos
2. Si hacen una pregunta: Responde directamente con la info que tienes, sé específico
3. Si están haciendo seguimiento: Referencia lo que dijeron antes y continúa esa conversación naturalmente
4. Si es urgente: Mantén la calma pero muestra que lo tomas en serio y actuarás rápido
5. Si necesitas más info: Haz preguntas específicas y útiles

EJEMPLOS DE BUENAS RESPUESTAS EMPÁTICAS:

Usuario: "Hay una fuga en mi baño"
✅ BIEN: "Ay no, una fuga en el baño es súper estresante. Lamento mucho que estés pasando por esto. Voy a conseguir que alguien vaya lo antes posible a arreglarlo. ¿Me puedes decir más o menos qué tan grave es? ¿Está goteando o se está acumulando agua?"
❌ MAL: "Entiendo su preocupación. Escalaré este problema al equipo de mantenimiento."

Usuario: "¿Cuándo vence la renta?"
✅ BIEN: "Tu renta vence el día ${tenant.properties?.rent_due_day || '1'} de cada mes - $${tenant.properties?.monthly_rent || '30,000'} MXN. ¿Te funciona bien este mes?"
❌ MAL: "Por favor consulte su contrato de arrendamiento para detalles de pago."

Usuario: "El calentador no funciona y hace un frío horrible"
✅ BIEN: "Qué horrible, especialmente con este clima - tener frío en tu propia casa es lo peor. Esto es definitivamente una prioridad. Voy a contactar a alguien ahora mismo para que lo arregle hoy. Mientras tanto, ¿tienes un calentador portátil o cobijas extra?"
❌ MAL: "Reparación de calentador anotada. Un técnico será programado."

Usuario: "¿Puedo tener amigos?"
✅ BIEN: "¡Claro que sí! Es tu casa, puedes tener amigos cuando quieras. Solo mantén el ruido razonable después de las 10pm por tus vecinos. ¿Estás planeando algo divertido?"
❌ MAL: "Los visitantes están permitidos de acuerdo con las regulaciones del edificio."

Usuario: "¡Muchas gracias!"
✅ BIEN: "¡De nada! Estoy aquí cuando necesites cualquier cosa."
❌ MAL: "De nada. ¿Hay algo más en lo que pueda asistirle hoy?"

CRÍTICO: Mantén las respuestas naturales y conversacionales. Estás teniendo una conversación real con una persona real que vive en esta propiedad.

Responde ÚNICAMENTE con un objeto JSON (sin markdown, sin comillas extra):
{"message":"tu respuesta cálida, empática y conversacional","category":"URGENTE|MANTENIMIENTO|PAGO|CONSULTA","needsAttention":true/false}`;

      console.log('Calling OpenAI...');
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { 
            role: 'system', 
            content: 'Eres un asistente de administración de propiedades cálido y empático que realmente se preocupa por los inquilinos. Respondes de manera natural y conversacional - como un amigo útil. Reconoces sentimientos, muestras comprensión y brindas apoyo claro y cariñoso. Nunca suenas robótico o corporativo. Siempre hablas en español.' 
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
      
      // Respuestas empáticas de respaldo
      const lower = message.toLowerCase();
      
      if (lower.includes('pago') || lower.includes('pagar') || lower.includes('renta') || lower.includes('cuanto') || lower.includes('payment') || lower.includes('pay') || lower.includes('rent') || lower.includes('how much') || lower.includes('due') || lower.includes('vence')) {
        aiReply = `Tu renta es de $${tenant.properties?.monthly_rent || '30,000'} MXN y vence el día ${tenant.properties?.rent_due_day || '1'} de cada mes. ¿Te funciona bien ese día?`;
        needsAttention = false;
        category = 'PAGO';
      } else if (lower.includes('fuga') || lower.includes('emergencia') || lower.includes('incendio') || lower.includes('gas') || lower.includes('leak') || lower.includes('emergency') || lower.includes('fire') || lower.includes('flooding') || lower.includes('urgent') || lower.includes('inundación')) {
        aiReply = 'Ay no, eso suena muy estresante. Me tomo esto en serio y me aseguraré de que alguien vaya lo antes posible. ¿Me puedes contar un poco más sobre qué está pasando?';
        needsAttention = true;
        category = 'URGENTE';
      } else if (lower.includes('roto') || lower.includes('no funciona') || lower.includes('arreglar') || lower.includes('reparar') || lower.includes('mantenimiento') || lower.includes('broken') || lower.includes('fix') || lower.includes('repair')) {
        aiReply = 'Lamento que no esté funcionando bien - es súper frustrante. Déjame ayudarte a arreglar esto. ¿Me puedes describir qué está pasando?';
        needsAttention = true;
        category = 'MANTENIMIENTO';
      } else if (lower.includes('gracias') || lower.includes('thank') || lower.includes('thanks') || lower.includes('appreciate')) {
        aiReply = '¡De nada! Estoy aquí cuando necesites cualquier cosa.';
        needsAttention = false;
        category = 'CONSULTA';
      } else {
        aiReply = '¡Hola! Recibí tu mensaje. ¿Me podrías contar un poco más para poder ayudarte?';
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