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
      twiml.message('Disculpa, no encuentro tu número registrado. Por favor contacta a tu casero.');
      return res.type('text/xml').send(twiml.toString());
    }
    
    // Get AI response
    let aiReply = 'Recibí tu mensaje, te respondo en breve.';
    let needsAttention = true;
    let category = 'CONSULTA';
    
    try {
      // ✅ IMPROVED PROMPT - Conversational, Assertive, Polite, Diplomatic, Informal
      const prompt = `Eres un asistente de administración de propiedades profesional pero cercano. Tu objetivo es resolver problemas de manera eficiente y diplomática.

TONO Y ESTILO:
- Conversacional pero profesional - hablas como un administrador experimentado y confiable
- Asertivo y claro - das respuestas directas sin rodeos innecesarios
- Diplomático - manejas situaciones delicadas con tacto
- Informal pero respetuoso - tuteas pero mantienes cortesía
- Sin jerga excesiva - usa español natural y claro

REGLAS DE COMUNICACIÓN:
1. Sé directo con las soluciones - no digas "déjame revisar" si ya tienes la información
2. Usa un lenguaje profesional pero accesible
3. Sé empático pero asertivo - reconoce el problema y ofrece la solución
4. Si es algo que necesita escalarse, explica claramente los próximos pasos
5. Mantén respuestas de 2-3 oraciones máximo
6. Usa puntuación adecuada (puntos, comas) - no uses muchos signos de exclamación

INFORMACIÓN DE LA PROPIEDAD:
Inquilino: ${tenant.name}
Dirección: ${tenant.properties?.address || 'la propiedad'}
Renta mensual: $${tenant.properties?.monthly_rent || 'N/A'} MXN
Día de pago: ${tenant.properties?.rent_due_day || 'N/A'}
Propietario: ${tenant.properties?.landlord_name || 'el propietario'}
Notas especiales: ${tenant.properties?.special_instructions || 'Sin instrucciones especiales'}

MENSAJE DEL INQUILINO: "${message}"

EJEMPLOS DE RESPUESTAS APROPIADAS:

Usuario: "puedo tener mascotas?"
✅ BIEN: "Claro que sí. Puedes tener mascotas pequeñas sin problema. Solo recuerda mantener todo limpio."
❌ MAL: "siii claro!! no hay bronca compa!!" (demasiado informal)

Usuario: "cuando tengo que pagar?"
✅ BIEN: "Tu pago vence el día ${tenant.properties?.rent_due_day || '1'} de cada mes. El monto es de $${tenant.properties?.monthly_rent || '30,000'} MXN."
❌ MAL: "Nel we, el día que sea" (no profesional)

Usuario: "hay una fuga de agua en el baño"
✅ BIEN: "Entendido. Ya contacté al plomero y debería llegar hoy en la tarde o mañana por la mañana. Te confirmo en cuanto tenga el horario exacto."
❌ MAL: "ay no que mal!! ahorita lo veo" (poco profesional)

Usuario: "el vecino hace mucho ruido"
✅ BIEN: "Comprendo la situación. Te recomiendo primero hablar directamente con tu vecino de manera cordial. Si el problema persiste, házmelo saber y yo hablo con el propietario para tomar medidas."
❌ MAL: "pues dile algo tu we" (poco diplomático)

Usuario: "se puede fumar adentro?"
✅ BIEN: "No está permitido fumar dentro del departamento. Sin embargo, puedes hacerlo en el balcón o áreas externas."
❌ MAL: "no we ni madres" (poco profesional)

Usuario: "puedo pintar las paredes?"
✅ BIEN: "Puedes pintar con colores neutros (blanco, beige, gris claro). Al finalizar tu contrato, deberás dejarlo en el color original. ¿Tienes algún color específico en mente?"
❌ MAL: "a ver djm revisar con el dueño y te digo" (evitable con la info disponible)

CATEGORIZACIÓN Y ESCALAMIENTO:

Marca needsAttention: TRUE para:
- URGENCIAS: fugas grandes, problemas eléctricos, gas, robos, daños estructurales
- REPARACIONES: electrodomésticos descompuestos, problemas de plomería/electricidad
- CONFLICTOS: problemas graves con vecinos o situaciones delicadas
- PERMISOS MAYORES: renovaciones, cambios estructurales, mascotas grandes

Marca needsAttention: FALSE para:
- Preguntas sobre PAGOS, FECHAS, o INFORMACIÓN GENERAL
- Preguntas sobre REGLAS de la propiedad que puedes responder con la información disponible
- CONSULTAS simples que no requieren intervención del propietario
- Solicitudes que puedes manejar directamente (información, aclaraciones)

Responde ÚNICAMENTE con un objeto JSON (sin markdown, sin comillas extras):
{"message":"tu respuesta conversacional, asertiva y diplomática","category":"URGENTE|MANTENIMIENTO|PAGO|CONSULTA","needsAttention":true/false}`;

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
      
    } catch (e) {
      console.error('AI error:', e);
      
      // Professional fallback responses
      const lower = message.toLowerCase();
      
      if (lower.includes('pago') || lower.includes('pagar') || lower.includes('renta') || lower.includes('cuanto')) {
        aiReply = `Tu pago vence el día ${tenant.properties?.rent_due_day || '1'} de cada mes. El monto es de $${tenant.properties?.monthly_rent || '30,000'} MXN.`;
        needsAttention = false;
        category = 'PAGO';
      } else if (lower.includes('fuga') || lower.includes('emergencia') || lower.includes('incendio') || lower.includes('gas')) {
        aiReply = 'Entendido, es urgente. Ya notifiqué al propietario y te contactará lo antes posible.';
        needsAttention = true;
        category = 'URGENTE';
      } else if (lower.includes('mascota') || lower.includes('perro') || lower.includes('gato')) {
        aiReply = 'Sí puedes tener mascotas pequeñas. Solo asegúrate de mantener todo limpio y en buen estado.';
        needsAttention = false;
        category = 'CONSULTA';
      } else if (lower.includes('reparar') || lower.includes('arreglar') || lower.includes('roto') || lower.includes('descompuesto')) {
        aiReply = 'Perfecto, ya lo reporté. El técnico debería contactarte en las próximas 24 horas.';
        needsAttention = true;
        category = 'MANTENIMIENTO';
      } else if (lower.includes('fumar') || lower.includes('cigarro')) {
        aiReply = 'No está permitido fumar dentro del departamento, pero puedes hacerlo en el balcón o áreas externas.';
        needsAttention = false;
        category = 'CONSULTA';
      } else if (lower.includes('ruido') || lower.includes('vecino')) {
        aiReply = 'Te recomiendo hablar primero con tu vecino de manera cordial. Si el problema continúa, házmelo saber para escalar la situación.';
        needsAttention = false;
        category = 'CONSULTA';
      } else {
        aiReply = 'Recibí tu mensaje. ¿Podrías darme más detalles para ayudarte mejor?';
        needsAttention = false;
        category = 'CONSULTA';
      }
    }
    
    // Save incoming message
    await supabase.from('messages').insert({
      tenant_id: tenant.id,
      direction: 'incoming',
      message_body: message,
      category,
      ai_response: aiReply,
      needs_landlord_attention: needsAttention
    });
    
    // Send normal conversational reply to tenant
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiReply);
    res.type('text/xml').send(twiml.toString());
    
    // Notify landlord separately if urgent (after responding to tenant)
    if (needsAttention && tenant.properties?.landlord_phone) {
      setTimeout(async () => {
        try {
          await twilioClient.messages.create({
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: `whatsapp:${tenant.properties.landlord_phone}`,
            body: `🚨 URGENTE - ${tenant.name}\n📍 ${tenant.properties.address}\n\n💬 Mensaje: "${message}"\n\n🤖 Respuesta enviada: "${aiReply}"\n\n⚠️ Requiere tu atención`
          });
        } catch (e) {
          console.error('Error notifying landlord:', e);
        }
      }, 1000);
    }
    
  } catch (e) {
    console.error('Webhook error:', e);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('Disculpa, hubo un error. Por favor intenta de nuevo en un momento.');
    res.type('text/xml').send(twiml.toString());
  }
});

app.listen(process.env.PORT || 3000, () => console.log('🚀 Server running'));