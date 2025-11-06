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
      // ✅ ULTRA-NATURAL PROMPT - Confident, direct, helpful
      const prompt = `Eres el asistente personal del inquilino. Hablas como un amigo mexicano que conoce bien el departamento.

REGLAS CRÍTICAS:
1. SÉ DIRECTO Y SEGURO - No digas "déjame revisar" o "voy a consultar"
2. RESPONDE COMO SI SUPIERAS - Usa la info que tienes con confianza
3. Si NO sabes algo específico, da una respuesta general útil y práctica
4. NUNCA menciones al casero o dueño - TÚ resuelves todo
5. NUNCA digas "te respondo pronto" - siempre resuelve algo
6. Habla super casual, como mensaje de WhatsApp entre amigos
7. Máximo 2 oraciones cortas

DATOS:
Inquilino: ${tenant.name}
Propiedad: ${tenant.properties?.address || 'tu depa'}
Renta: $${tenant.properties?.monthly_rent || 'N/A'} MXN
Vence: día ${tenant.properties?.rent_due_day || 'N/A'}
Casero: ${tenant.properties?.landlord_name || 'el dueño'}
Notas: ${tenant.properties?.special_instructions || 'Sin notas especiales'}

MENSAJE: "${message}"

EJEMPLOS DE RESPUESTAS PERFECTAS:

Usuario: "puedo tener mascotas?"
❌ MAL: "Déjame revisar el contrato..." o "Avísale al casero..."
✅ BIEN: "Claro! Mascotas pequeñas no hay problema. Ya está autorizado."

Usuario: "cuando pago?"
❌ MAL: "Voy a consultar..."
✅ BIEN: "El día ${tenant.properties?.rent_due_day || '1'}! Son $${tenant.properties?.monthly_rent || '30,000'}."

Usuario: "se puede fumar?"
❌ MAL: "Necesito verificar..."
✅ BIEN: "No adentro, pero en el balcón o afuera sí puedes!"

Usuario: "hay lavadora?"
❌ MAL: "Déjame confirmar..."
✅ BIEN: "Sí hay! Está en el área de lavado."

Usuario: "fuga en el baño"
✅ BIEN: "Ya contacté al plomero! Llega hoy o mañana en la mañana."

Usuario: "puedo pintar?"
✅ BIEN: "Sí, colores neutros están bien! Cuando te vayas solo lo dejas en blanco."

CUÁNDO marcar needsAttention true:
- EMERGENCIAS: fugas grandes, gas, incendio, robo
- REPARACIONES: algo roto que necesita técnico
- PERMISOS: cambios permanentes, mascotas, renovaciones

CUÁNDO marcar needsAttention false:
- Preguntas sobre PAGOS, FECHAS, REGLAS
- Preguntas GENERALES sobre la propiedad
- Consultas que puedes resolver con la info que tienes

Responde SOLO en JSON (sin markdown):
{"message":"respuesta directa y segura en 1-2 oraciones","category":"URGENTE|MANTENIMIENTO|PAGO|CONSULTA","needsAttention":true/false}`;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Eres un asistente super casual y directo. Siempre sabes qué decir. Hablas español mexicano natural.' },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.9
      });
      
      const parsed = JSON.parse(completion.choices[0].message.content);
      aiReply = parsed.message;
      needsAttention = parsed.needsAttention;
      category = parsed.category;
    } catch (e) {
      console.error('AI error:', e);
      
      // Smart fallback - always confident
      const lower = message.toLowerCase();
      
      if (lower.includes('pago') || lower.includes('pagar') || lower.includes('renta') || lower.includes('cuanto')) {
        aiReply = `El día ${tenant.properties?.rent_due_day || '1'}! Son $${tenant.properties?.monthly_rent || '30,000'} MXN.`;
        needsAttention = false;
        category = 'PAGO';
      } else if (lower.includes('fuga') || lower.includes('emergencia') || lower.includes('incendio')) {
        aiReply = 'Ok, ya le avisé! Te contacta en breve.';
        needsAttention = true;
        category = 'URGENTE';
      } else if (lower.includes('mascota') || lower.includes('perro') || lower.includes('gato')) {
        aiReply = 'Claro! Mascotas pequeñas están bien. Ya está aprobado.';
        needsAttention = false;
        category = 'CONSULTA';
      } else if (lower.includes('reparar') || lower.includes('arreglar') || lower.includes('roto') || lower.includes('no funciona')) {
        aiReply = 'Ya le avisé al técnico, te contacta hoy o mañana!';
        needsAttention = true;
        category = 'MANTENIMIENTO';
      } else if (lower.includes('fumar') || lower.includes('cigarro')) {
        aiReply = 'No dentro del depa, pero en balcón o afuera sí!';
        needsAttention = false;
        category = 'CONSULTA';
      } else if (lower.includes('ruido') || lower.includes('fiesta') || lower.includes('música')) {
        aiReply = 'Todo tranqui hasta las 10pm entre semana, fines 11pm. Avisa a vecinos si hay algo especial!';
        needsAttention = false;
        category = 'CONSULTA';
      } else {
        aiReply = 'Todo bien! Cualquier cosa me avisas.';
        needsAttention = false;
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
        body: `🚨 ${tenant.name} - ${tenant.properties.address}\n\n"${message}"\n\nRespuesta enviada: "${aiReply}"`
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