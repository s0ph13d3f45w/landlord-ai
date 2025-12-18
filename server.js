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
      conversationContext = '\n\nRECENT CONVERSATION HISTORY:\n';
      recentMessages.forEach((msg) => {
        if (msg.direction === 'incoming') {
          conversationContext += `Tenant: "${msg.message_body}"\n`;
          if (msg.ai_response) {
            conversationContext += `You: "${msg.ai_response}"\n`;
          }
        }
      });
      conversationContext += '\n⚠️ IMPORTANT: This is the previous conversation context. The tenant\'s current message may be a continuation or follow-up. Respond coherently considering what has already been discussed.';
    }
    
    // Detect language of the message
    console.log('\n🌍 DETECTING LANGUAGE');
    const messageToCheck = message.toLowerCase();
    const spanishIndicators = ['hola', 'gracias', 'por favor', 'sí', 'no', 'qué', 'cómo', 'dónde', 'cuándo', 'está', 'hay', 'tengo', 'puedo', 'necesito', 'el', 'la', 'los', 'las', 'un', 'una'];
    const englishIndicators = ['hello', 'hi', 'thanks', 'please', 'yes', 'what', 'how', 'where', 'when', 'there', 'have', 'can', 'need', 'the', 'a', 'an', 'is', 'are'];
    
    let spanishScore = 0;
    let englishScore = 0;
    
    spanishIndicators.forEach(word => {
      if (messageToCheck.includes(word)) spanishScore++;
    });
    
    englishIndicators.forEach(word => {
      if (messageToCheck.includes(word)) englishScore++;
    });
    
    // Default to Spanish if unclear (Mexico context)
    const isSpanish = spanishScore >= englishScore;
    const detectedLanguage = isSpanish ? 'Spanish' : 'English';
    console.log(`Detected language: ${detectedLanguage} (Spanish: ${spanishScore}, English: ${englishScore})`);
    
    // Get AI response
    console.log('\n🤖 GENERATING AI RESPONSE');
    let aiReply = isSpanish 
      ? '¡Hola! Recibí tu mensaje y lo estoy revisando. Te respondo en un momento.'
      : 'Hey! I got your message and I\'m looking into it. I\'ll get back to you in just a moment.';
    let needsAttention = true;
    let category = isSpanish ? 'CONSULTA' : 'INQUIRY';
    
    try {
      const prompt = isSpanish ? `Eres un asistente de administración de propiedades cálido y empático. Realmente te importan tus inquilinos y quieres que se sientan escuchados y apoyados.

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
1. Si es la primera mención de un problema: Muestra empatía, haz preguntas específicas (¿Dónde exactamente? ¿Qué tan grave?), explica que lo resolverás
2. Si están dando más detalles (seguimiento): Haz referencia a lo que dijeron antes ("Entiendo, entonces la fuga es en la cocina..."), confirma que entiendes la situación completa, da los siguientes pasos concretos
3. Categorización: URGENTE (fugas grandes, eléctrico, gas → needsAttention: true), MANTENIMIENTO (reparaciones necesarias → needsAttention: true), PAGO (preguntas sobre renta → needsAttention: false), CONSULTA (preguntas generales → needsAttention: false)

EJEMPLOS:
Inquilino: "Hay una fuga de agua"
Tú: "Ay no, una fuga es súper estresante. ¿Dónde exactamente está la fuga? ¿En el baño, cocina?"
Inquilino: "En la cocina"
Tú: "Entiendo, entonces la fuga es en la cocina. ¿Es del fregadero, de abajo del lavabo, o de alguna tubería? Necesito contactar al plomero y confirmarle exactamente dónde ir."

Responde ÚNICAMENTE con un objeto JSON (sin markdown):
{"message":"tu respuesta cálida, empática y coherente con el contexto","category":"URGENTE|MANTENIMIENTO|PAGO|CONSULTA","needsAttention":true/false}` 
      : 
      `You are a warm, empathetic property management assistant. You genuinely care about your tenants and want to help them feel heard and supported.

COMMUNICATION STYLE:
- EMPATHETIC FIRST: Always acknowledge their feelings and concerns before offering solutions
- CONVERSATIONAL: Speak naturally, like a helpful friend who manages their property
- CONTEXT-AWARE: Remember what they're saying and respond coherently to their specific situation
- WARM but PROFESSIONAL: Be friendly and caring while maintaining professionalism
- CLEAR & DIRECT: Give specific, actionable information when you have it
- FOLLOW-UP: If they're continuing a previous conversation, reference what they said before

PROPERTY INFORMATION:
Tenant: ${tenant.name}
Address: ${tenant.properties?.address || 'the property'}
Monthly rent: $${tenant.properties?.monthly_rent || 'N/A'} MXN
Payment due: Day ${tenant.properties?.rent_due_day || 'N/A'} of each month
Landlord: ${tenant.properties?.landlord_name || 'the landlord'}
Special notes: ${tenant.properties?.special_instructions || 'None'}
${conversationContext}

CURRENT TENANT MESSAGE: "${message}"

RESPONSE GUIDELINES:
1. If it's the first mention of a problem: Show empathy, ask specific questions (Where exactly? How bad?), explain you'll resolve it
2. If they're giving more details (follow-up): Reference what they said before ("I understand, so the leak is in the kitchen..."), confirm you understand the complete situation, give concrete next steps
3. Categorization: URGENT (large leaks, electrical, gas → needsAttention: true), MAINTENANCE (needed repairs → needsAttention: true), PAYMENT (rent questions → needsAttention: false), INQUIRY (general questions → needsAttention: false)

EXAMPLES:
Tenant: "There's a water leak"
You: "Oh no, a water leak is really stressful. Where exactly is the leak? In the bathroom, kitchen?"
Tenant: "In the kitchen"
You: "I understand, so the leak is in the kitchen. Is it from the sink, under the cabinet, or from a pipe? I need to contact the plumber and tell them exactly where to check."

Respond ONLY with a JSON object (no markdown):
{"message":"your warm, empathetic response coherent with the context","category":"URGENT|MAINTENANCE|PAYMENT|INQUIRY","needsAttention":true/false}`;

      console.log('Calling OpenAI...');
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { 
            role: 'system', 
            content: isSpanish 
              ? 'Eres un asistente de administración de propiedades cálido y empático que realmente se preocupa por los inquilinos. Respondes de manera natural y conversacional - como un amigo útil. Reconoces sentimientos, muestras comprensión y brindas apoyo claro y cariñoso. IMPORTANTE: Tienes memoria de la conversación - siempre haces referencia a mensajes anteriores y mantienes la coherencia. Nunca suenas robótico o corporativo. Siempre hablas en español.'
              : 'You are a warm, empathetic property management assistant who genuinely cares about tenants. You respond in a natural, conversational way - like a helpful friend. You acknowledge feelings, show understanding, and provide clear, caring support. IMPORTANT: You have conversation memory - always reference previous messages and maintain coherence. You never sound robotic or corporate. Always speak in English.'
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
      
      // Bilingual empathetic fallback responses with context
      const lower = message.toLowerCase();
      
      // Check if this is a follow-up (short message after recent conversation)
      const isFollowUp = recentMessages.length > 0 && message.length < 30;
      
      if (isSpanish) {
        // Spanish fallbacks
        if (lower.includes('pago') || lower.includes('pagar') || lower.includes('renta') || lower.includes('cuanto') || lower.includes('vence')) {
          aiReply = `Tu renta es de $${tenant.properties?.monthly_rent || '30,000'} MXN y vence el día ${tenant.properties?.rent_due_day || '1'} de cada mes. ¿Te funciona bien ese día?`;
          needsAttention = false;
          category = 'PAGO';
        } else if (lower.includes('fuga') || lower.includes('emergencia') || lower.includes('incendio') || lower.includes('gas') || lower.includes('inundación')) {
          if (isFollowUp) {
            aiReply = 'Perfecto, ya tengo más info. Voy a contactar al técnico apropiado ahora mismo y te confirmo el horario lo antes posible.';
          } else {
            aiReply = 'Ay no, eso suena muy estresante. Me tomo esto en serio y me aseguraré de que alguien vaya lo antes posible. ¿Me puedes contar un poco más sobre qué está pasando?';
          }
          needsAttention = true;
          category = 'URGENTE';
        } else if (lower.includes('roto') || lower.includes('no funciona') || lower.includes('arreglar') || lower.includes('reparar') || lower.includes('mantenimiento')) {
          if (isFollowUp) {
            aiReply = 'Entiendo. Con esa información voy a programar a alguien para que lo revise. Te confirmo en cuanto tenga el horario.';
          } else {
            aiReply = 'Lamento que no esté funcionando bien - es súper frustrante. Déjame ayudarte a arreglar esto. ¿Me puedes describir qué está pasando?';
          }
          needsAttention = true;
          category = 'MANTENIMIENTO';
        } else if (lower.includes('gracias')) {
          aiReply = '¡De nada! Estoy aquí cuando necesites cualquier cosa.';
          needsAttention = false;
          category = 'CONSULTA';
        } else if (isFollowUp && recentMessages.length > 0) {
          aiReply = 'Perfecto, ya tengo esa información. Dame un momento para coordinarlo todo y te confirmo.';
          needsAttention = true;
          category = 'CONSULTA';
        } else {
          aiReply = '¡Hola! Recibí tu mensaje. ¿Me podrías contar un poco más para poder ayudarte?';
          needsAttention = false;
          category = 'CONSULTA';
        }
      } else {
        // English fallbacks
        if (lower.includes('payment') || lower.includes('pay') || lower.includes('rent') || lower.includes('how much') || lower.includes('due')) {
          aiReply = `Your rent is $${tenant.properties?.monthly_rent || '30,000'} MXN and it's due on day ${tenant.properties?.rent_due_day || '1'} of each month. Does that timing work for you?`;
          needsAttention = false;
          category = 'PAYMENT';
        } else if (lower.includes('leak') || lower.includes('emergency') || lower.includes('fire') || lower.includes('flooding') || lower.includes('urgent')) {
          if (isFollowUp) {
            aiReply = 'Perfect, I have more info now. I\'ll contact the appropriate technician right away and confirm the schedule as soon as possible.';
          } else {
            aiReply = 'Oh no, that sounds really stressful. I\'m taking this seriously and will make sure someone gets out there as soon as possible. Can you tell me a bit more about what\'s happening?';
          }
          needsAttention = true;
          category = 'URGENT';
        } else if (lower.includes('broken') || lower.includes('not working') || lower.includes('fix') || lower.includes('repair')) {
          if (isFollowUp) {
            aiReply = 'Got it. With that information I\'ll schedule someone to check it out. I\'ll confirm the time as soon as I have it.';
          } else {
            aiReply = 'I\'m sorry that\'s not working properly - that\'s really frustrating. Let me help you get this fixed. Can you describe what\'s going on?';
          }
          needsAttention = true;
          category = 'MAINTENANCE';
        } else if (lower.includes('thank') || lower.includes('thanks') || lower.includes('appreciate')) {
          aiReply = 'You\'re so welcome! I\'m here whenever you need anything.';
          needsAttention = false;
          category = 'INQUIRY';
        } else if (isFollowUp && recentMessages.length > 0) {
          aiReply = 'Perfect, I have that information now. Give me a moment to coordinate everything and I\'ll confirm with you.';
          needsAttention = true;
          category = 'INQUIRY';
        } else {
          aiReply = 'Hey! I got your message. Could you tell me a bit more so I can help you out?';
          needsAttention = false;
          category = 'INQUIRY';
        }
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