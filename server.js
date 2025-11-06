require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const twilio = require('twilio');
const Dedalus = require('dedalus-labs'); // ✅ Default import
const { createClient } = require('@supabase/supabase-js');

// Initialize Express app
const app = express();

// Validate required environment variables
const requiredEnvVars = [
  'DEDALUS_API_KEY',
  'SUPABASE_URL', 
  'SUPABASE_SERVICE_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_NUMBER'
];

console.log('\n🔍 Checking Environment Variables...');
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingVars);
} else {
  console.log('✅ All required environment variables are set');
}

// Initialize services
let dedalus, supabase, twilioClient;

try {
  // ✅ CORRECT: Default import, not destructured
  dedalus = new Dedalus({ apiKey: process.env.DEDALUS_API_KEY });
  console.log('✅ Dedalus initialized');
} catch (error) {
  console.error('❌ Dedalus initialization failed:', error.message);
}

try {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  console.log('✅ Supabase initialized');
} catch (error) {
  console.error('❌ Supabase initialization failed:', error.message);
}

try {
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  console.log('✅ Twilio initialized');
} catch (error) {
  console.error('❌ Twilio initialization failed:', error.message);
}

// Set up view engine
app.set('view engine', 'ejs');
app.set('views', './views');

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true
  }
}));

// ============================================
// DEBUGGING ENDPOINTS
// ============================================

// Test Dedalus - ✅ CORRECT FORMAT
app.get('/test-dedalus', async (req, res) => {
  try {
    console.log('\n🧪 Testing Dedalus AI...');
    console.log('API Key present:', !!process.env.DEDALUS_API_KEY);
    
    // ✅ CORRECT: Use "input" not "messages"
    const completion = await dedalus.chat.create({
      input: [{ role: 'user', content: 'Say "Hello, Dedalus is working!"' }],
      model: 'gpt-4o-mini'
    });
    
    console.log('✅ Dedalus response:', completion);
    
    res.send(`✅ Dedalus AI is working!\n\nResponse: ${JSON.stringify(completion, null, 2)}`);
  } catch (error) {
    console.error('❌ Dedalus Error:', error);
    res.status(500).send(`❌ Dedalus Error: ${error.message}\n\nStack: ${error.stack}`);
  }
});

// Test Database
app.get('/test-database', async (req, res) => {
  try {
    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('id, name, phone')
      .limit(10);
    
    if (error) throw error;
    
    res.json({
      success: true,
      tenantCount: tenants?.length || 0,
      tenants: tenants
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// Test all
app.get('/test-all', async (req, res) => {
  const results = {
    twilio: '❌',
    dedalus: '❌', 
    database: '❌'
  };
  
  try {
    await twilioClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    results.twilio = '✅ Connected';
  } catch (e) {
    results.twilio = `❌ ${e.message}`;
  }
  
  try {
    await dedalus.chat.create({
      input: [{ role: 'user', content: 'test' }],
      model: 'gpt-4o-mini'
    });
    results.dedalus = '✅ Connected';
  } catch (e) {
    results.dedalus = `❌ ${e.message}`;
  }
  
  try {
    const { error } = await supabase.from('tenants').select('id').limit(1);
    if (error) throw error;
    results.database = '✅ Connected';
  } catch (e) {
    results.database = `❌ ${e.message}`;
  }
  
  res.json(results);
});

// ============================================
// IMPORT ROUTES
// ============================================

const initAuthRoutes = require('./routes/auth');
const initDashboardRoutes = require('./routes/dashboard');
const initPasswordResetRoutes = require('./routes/password-reset');

app.use('/', initAuthRoutes(supabase));
app.use('/', initDashboardRoutes(supabase, twilioClient));
app.use('/', initPasswordResetRoutes(supabase));

app.get('/', (req, res) => {
  if (req.session.landlordId) {
    res.redirect('/dashboard');
  } else {
    res.redirect('/login');
  }
});

// ============================================
// WHATSAPP WEBHOOK
// ============================================

app.post('/webhook/whatsapp', async (req, res) => {
  try {
    console.log('\n📱 NEW WHATSAPP MESSAGE');
    
    const incomingMessage = req.body.Body;
    const rawFrom = req.body.From;
    const senderPhone = rawFrom?.replace('whatsapp:', '') || rawFrom;
    
    if (!incomingMessage || !senderPhone) {
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Error: datos incompletos');
      return res.type('text/xml').send(twiml.toString());
    }
    
    // Find tenant
    let tenant = null;
    const phoneVariations = [
      senderPhone,
      senderPhone.replace('+52', ''),
      '+52' + senderPhone.replace(/^\+?52/, ''),
      senderPhone.replace(/\s+/g, '')
    ];
    
    for (const phoneVariation of phoneVariations) {
      const { data, error } = await supabase
        .from('tenants')
        .select(`*, properties (*)`)
        .eq('phone', phoneVariation)
        .single();
      
      if (data && !error) {
        tenant = data;
        break;
      }
    }
    
    if (!tenant) {
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Lo siento, no reconozco este número.');
      return res.type('text/xml').send(twiml.toString());
    }
    
    // Get AI response
    let aiResponse;
    try {
      aiResponse = await generateAIResponse(incomingMessage, tenant, tenant.properties);
    } catch (aiError) {
      console.error('❌ AI Error:', aiError);
      aiResponse = {
        message: 'Hola, recibí tu mensaje. El casero responderá pronto.',
        category: 'CONSULTA',
        needsAttention: true
      };
    }
    
    // Save to database
    await supabase.from('messages').insert([{
      tenant_id: tenant.id,
      direction: 'incoming',
      message_body: incomingMessage,
      category: aiResponse.category,
      ai_response: aiResponse.message,
      needs_landlord_attention: aiResponse.needsAttention
    }]);
    
    // Notify landlord if urgent
    if (aiResponse.needsAttention) {
      try {
        await notifyLandlord(tenant, incomingMessage, tenant.properties);
      } catch (e) {
        console.error('Notification error:', e);
      }
    }
    
    // Send response
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiResponse.message);
    res.type('text/xml').send(twiml.toString());
    
  } catch (error) {
    console.error('❌ WEBHOOK ERROR:', error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('Disculpa, hubo un error.');
    res.type('text/xml').send(twiml.toString());
  }
});

// ============================================
// AI RESPONSE GENERATION - ✅ CORRECT FORMAT
// ============================================

async function generateAIResponse(message, tenant, property) {
  const prompt = `Eres un asistente virtual para inquilinos en México.

INFORMACIÓN:
- Inquilino: ${tenant.name}
- Propiedad: ${property?.address || 'N/A'}
- Renta: $${property?.monthly_rent || 'N/A'} MXN
- Día de pago: ${property?.rent_due_day || 'N/A'}
- Casero: ${property?.landlord_name || 'N/A'}

MENSAJE: "${message}"

Responde directamente si puedes. Solo marca needsAttention: true para emergencias o reparaciones.

Responde en JSON:
{
  "message": "Tu respuesta (máximo 400 caracteres)",
  "category": "URGENTE|MANTENIMIENTO|PAGO|CONSULTA",
  "needsAttention": true o false
}`;

  try {
    // ✅ CORRECT: Use "input" not "messages"
    const completion = await dedalus.chat.create({
      input: [
        { role: 'system', content: 'You are a helpful assistant that responds in JSON format.' },
        { role: 'user', content: prompt }
      ],
      model: 'gpt-4o-mini',
      temperature: 0.7
    });
    
    // Parse the response - structure may vary
    let responseText;
    if (completion.choices && completion.choices[0]) {
      responseText = completion.choices[0].message?.content || completion.choices[0].text;
    } else if (completion.content) {
      responseText = completion.content;
    } else {
      throw new Error('Unexpected response format');
    }
    
    console.log('Raw AI response:', responseText);
    
    // Try to parse JSON
    const response = JSON.parse(responseText);
    response.needsAttention = response.needsAttention === true;
    return response;
    
  } catch (error) {
    console.error('AI Error:', error);
    
    // Fallback
    const lower = message.toLowerCase();
    
    if (lower.includes('fuga') || lower.includes('emergencia')) {
      return {
        message: '🚨 He notificado a tu casero sobre esta emergencia.',
        category: 'URGENTE',
        needsAttention: true
      };
    }
    
    if (lower.includes('pago') || lower.includes('renta')) {
      return {
        message: `Tu renta es $${property?.monthly_rent || 'N/A'} MXN, vence el día ${property?.rent_due_day || 'N/A'}.`,
        category: 'PAGO',
        needsAttention: false
      };
    }
    
    return {
      message: 'Recibí tu mensaje. Te respondo pronto.',
      category: 'CONSULTA',
      needsAttention: true
    };
  }
}

async function notifyLandlord(tenant, tenantMessage, property) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: `whatsapp:${property.landlord_phone}`,
    body: `🚨 ${tenant.name} (${property.address}): "${tenantMessage}"`
  });
}

// Daily recap
async function sendDailyRecap() {
  try {
    const { data: landlords } = await supabase.from('landlords').select('*');
    
    for (const landlord of landlords) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      
      const { data: properties } = await supabase
        .from('properties')
        .select('id')
        .eq('landlord_id', landlord.id);
      
      if (!properties?.length) continue;
      
      const propertyIds = properties.map(p => p.id);
      
      const { data: tenants } = await supabase
        .from('tenants')
        .select('id')
        .in('property_id', propertyIds);
      
      if (!tenants?.length) continue;
      
      const tenantIds = tenants.map(t => t.id);
      
      const { data: messages } = await supabase
        .from('messages')
        .select('*')
        .in('tenant_id', tenantIds)
        .gte('created_at', yesterday.toISOString());
      
      if (messages?.length > 0) {
        const urgent = messages.filter(m => m.needs_landlord_attention).length;
        
        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_NUMBER,
          to: `whatsapp:${landlord.phone}`,
          body: `📊 Mensajes: ${messages.length} | Urgentes: ${urgent}`
        });
      }
    }
  } catch (error) {
    console.error('Daily recap error:', error);
  }
}

const cron = require('node-cron');
cron.schedule('0 20 * * *', sendDailyRecap, {
  timezone: "America/Mexico_City"
});

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n🚀 SERVER STARTED');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🧪 Test: /test-dedalus\n`);
});