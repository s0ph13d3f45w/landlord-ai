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
      twiml.message('Error: missing message or phone number');
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
      twiml.message('Sorry, I can\'t find your number in our system. Please contact your landlord.');
      console.log('\n📤 Sending "not found" response');
      return res.type('text/xml').send(twiml.toString());
    }
    
    console.log('\n✅ TENANT FOUND:', {
      name: tenant.name,
      phone: tenant.phone,
      property: tenant.properties?.address
    });
    
    // Get recent conversation history (last 10 messages)
    console.log('\n📜 RETRIEVING CONVERSATION HISTORY');
    const { data: conversationHistory } = await supabase
      .from('messages')
      .select('direction, message_body, ai_response, created_at')
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false })
      .limit(10);
    
    // Reverse to get chronological order (oldest first)
    const recentMessages = conversationHistory?.reverse() || [];
    console.log(`Found ${recentMessages.length} recent messages`);
    
    // Build conversation context
    let conversationContext = '';
    if (recentMessages.length > 0) {
      conversationContext = '\n\nHISTORIAL DE CONVERSACIÓN RECIENTE:\n';
      recentMessages.forEach((msg) => {
        if (msg.direction === 'incoming') {
          conversationContext += `Inquilino: "${msg.message_body}"\n`;
          if (msg.ai_response) {
            conversationContext += `Tú: "${msg.ai_response}"\n`;
          }
        }
      });
      conversationContext += '\n⚠️ IMPORTANTE: Este es el contexto de la conversación previa. El mensaje actual del inquilino puede ser una continuación o seguimiento. Responde de manera coherente considerando lo que ya se ha discutido.';
    }
    
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
- SEGUIMIENTO: Si están continuando una conversación previa, haz referencia a lo que dijeron antes

INFORMACIÓN DE LA PROPIEDAD:
Inquilino: ${tenant.name}
Dirección: ${tenant.properties?.address || 'la propiedad'}
Renta mensual: $${tenant.properties?.monthly_rent || 'N/A'} MXN
Vencimiento de pago: Día ${tenant.properties?.rent_due_day || 'N/A'} de cada mes
Propietario: ${tenant.properties?.landlord_name || 'el propietario'}
Notas especiales: ${tenant.properties?.special_instructions || 'Ninguna'}
${conversationContext}

MENSAJE ACTUAL DEL INQUILINO: "${message}"

GUÍAS DE RESPUESTA:

1. **Si es la primera mención de un problema:**
   - Muestra empatía
   - Haz preguntas específicas para entender mejor (¿Dónde exactamente? ¿Qué tan grave?)
   - Explica que lo resolverás

2. **Si están dando más detalles (seguimiento):**
   - Haz referencia a lo que dijeron antes ("Entiendo, entonces la fuga es en la cocina...")
   - Confirma que entiendes la situación completa
   - Da los siguientes pasos concretos ("Voy a contactar al plomero y te confirmo el horario")

3. **Categorización correcta:**
   - URGENTE: Fugas grandes, problemas eléctricos, gas, emergencias reales → needsAttention: true
   - MANTENIMIENTO: Reparaciones necesarias pero no urgentes → needsAttention: true
   - PAGO: Preguntas sobre renta, pagos → needsAttention: false
   - CONSULTA: Preguntas generales, permisos simples → needsAttention: false

EJEMPLOS DE SEGUIMIENTO COHERENTE:

**Conversación completa:**
Inquilino: "Hay una fuga de agua"
Tú: "Ay no, una fuga es súper estresante. ¿Dónde exactamente está la fuga? ¿En el baño, cocina?"

Inquilino: "En la cocina"
✅ BIEN: "Entiendo, entonces la fuga es en la cocina. ¿Es del fregadero, de abajo del lavabo, o de alguna tubería? Necesito contactar al plomero y confirmarle exactamente dónde ir."
❌ MAL: "¿Dónde está la fuga?" (ya te lo dijeron - es en la cocina!)

**Otro ejemplo:**
Inquilino: "El calentador no funciona"
Tú: "Lamento que el calentador no funcione - debe estar muy incómodo. ¿No prende para nada o simplemente no calienta bien?"

Inquilino: "No prende"
✅ BIEN: "Okay, entonces el calentador no prende del todo. Eso es definitivamente algo que necesita un técnico. Voy a contactar al especialista de calentadores y te confirmo cuándo puede ir. Mientras tanto, ¿tienes cobijas extra?"
❌ MAL: "¿Cuál es el problema exactamente?" (ya te lo dijo!)

RESPONDE SIEMPRE de manera que demuestre que ENTIENDES el contexto completo de la conversación.

Responde ÚNICAMENTE con un objeto JSON (sin markdown, sin comillas extra):
{"message":"tu respuesta cálida, empática y coherente con el contexto","category":"URGENTE|MANTENIMIENTO|PAGO|CONSULTA","needsAttention":true/false}`;

      console.log('Calling OpenAI...');
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { 
            role: 'system', 
            content: 'Eres un asistente de administración de propiedades cálido y empático que realmente se preocupa por los inquilinos. Respondes de manera natural y conversacional - como un amigo útil. Reconoces sentimientos, muestras comprensión y brindas apoyo claro y cariñoso. IMPORTANTE: Tienes memoria de la conversación - siempre haces referencia a mensajes anteriores y mantienes la coherencia. Nunca suenas robótico o corporativo. Siempre hablas en español.' 
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
      
      // Respuestas empáticas de respaldo con contexto
      const lower = message.toLowerCase();
      
      // Check if this is a follow-up (short message after recent conversation)
      const isFollowUp = recentMessages.length > 0 && message.length < 30;
      
      if (lower.includes('pago') || lower.includes('pagar') || lower.includes('renta') || lower.includes('cuanto') || lower.includes('payment') || lower.includes('pay') || lower.includes('rent') || lower.includes('how much') || lower.includes('due') || lower.includes('vence')) {
        aiReply = `Tu renta es de $${tenant.properties?.monthly_rent || '30,000'} MXN y vence el día ${tenant.properties?.rent_due_day || '1'} de cada mes. ¿Te funciona bien ese día?`;
        needsAttention = false;
        category = 'PAGO';
      } else if (lower.includes('fuga') || lower.includes('emergencia') || lower.includes('incendio') || lower.includes('gas') || lower.includes('leak') || lower.includes('emergency') || lower.includes('fire') || lower.includes('flooding') || lower.includes('urgent') || lower.includes('inundación')) {
        if (isFollowUp) {
          aiReply = 'Perfecto, ya tengo más info. Voy a contactar al técnico apropiado ahora mismo y te confirmo el horario lo antes posible.';
        } else {
          aiReply = 'Ay no, eso suena muy estresante. Me tomo esto en serio y me aseguraré de que alguien vaya lo antes posible. ¿Me puedes contar un poco más sobre qué está pasando?';
        }
        needsAttention = true;
        category = 'URGENTE';
      } else if (lower.includes('roto') || lower.includes('no funciona') || lower.includes('arreglar') || lower.includes('reparar') || lower.includes('mantenimiento') || lower.includes('broken') || lower.includes('fix') || lower.includes('repair')) {
        if (isFollowUp) {
          aiReply = 'Entiendo. Con esa información voy a programar a alguien para que lo revise. Te confirmo en cuanto tenga el horario.';
        } else {
          aiReply = 'Lamento que no esté funcionando bien - es súper frustrante. Déjame ayudarte a arreglar esto. ¿Me puedes describir qué está pasando?';
        }
        needsAttention = true;
        category = 'MANTENIMIENTO';
      } else if (lower.includes('gracias') || lower.includes('thank') || lower.includes('thanks') || lower.includes('appreciate')) {
        aiReply = '¡De nada! Estoy aquí cuando necesites cualquier cosa.';
        needsAttention = false;
        category = 'CONSULTA';
      } else if (isFollowUp && recentMessages.length > 0) {
        // For short follow-up messages, acknowledge we understand it's a continuation
        aiReply = 'Perfecto, ya tengo esa información. Dame un momento para coordinarlo todo y te confirmo.';
        needsAttention = true;
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
    
    // Send follow-up for urgent issues
    if (needsAttention) {
      console.log('⏱️  Scheduling follow-up message in 10 seconds...');
      setTimeout(async () => {
        try {
          let followUpMessage = '';
          const lower = message.toLowerCase();
          let professional = 'the technician';
          let professionalName = 'Rosendo';
          let timeSlot = '10:00 am';
          
          if (lower.includes('fuga') || lower.includes('agua') || lower.includes('tubería') || lower.includes('baño') || lower.includes('leak') || lower.includes('water') || lower.includes('pipe') || lower.includes('bathroom')) {
            professional = 'the plumber';
            professionalName = 'Rosendo';
            timeSlot = '10:00 am';
          } else if (lower.includes('luz') || lower.includes('eléctric') || lower.includes('light') || lower.includes('electric') || lower.includes('power')) {
            professional = 'the electrician';
            professionalName = 'Miguel';
            timeSlot = '2:00 pm';
          }
          
          if (category === 'URGENT' || category === 'MAINTENANCE') {
            followUpMessage = `All set, I spoke with ${professional}. He's available at ${timeSlot} and will come by to check it out. His name is ${professionalName}. Let me know how it goes, and don't worry, I'll take care of paying him.`;
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
    twiml.message('Sorry, there was an error. Please try again in a moment.');
    res.type('text/xml').send(twiml.toString());
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 SERVER RUNNING ON PORT', process.env.PORT || 3000);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});