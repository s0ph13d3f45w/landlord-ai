require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const twilio = require('twilio');
const { Dedalus } = require('dedalus-labs');
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
  console.error('⚠️  App may not function correctly!');
} else {
  console.log('✅ All required environment variables are set');
}

// Initialize services with error handling
let dedalus, supabase, twilioClient;

try {
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

// Set up view engine (for HTML templates)
app.set('view engine', 'ejs');
app.set('views', './views');

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// Session middleware (for login)
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

// Test Dedalus AI - ✅ FIXED: Correct API call
app.get('/test-dedalus', async (req, res) => {
  try {
    console.log('\n🧪 Testing Dedalus AI...');
    console.log('API Key present:', !!process.env.DEDALUS_API_KEY);
    
    // ✅ CORRECT: Use dedalus.chat.create() not dedalus.chat.completions.create()
    const completion = await dedalus.chat.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Say "Hello, Dedalus is working!"' }],
      temperature: 0.7
    });
    
    const response = completion.choices[0].message.content;
    console.log('✅ Dedalus response:', response);
    
    res.send(`✅ Dedalus AI is working!\n\nResponse: ${response}`);
  } catch (error) {
    console.error('❌ Dedalus Error:', error);
    res.status(500).send(`❌ Dedalus Error: ${error.message}\n\nCheck your DEDALUS_API_KEY in environment variables.`);
  }
});

// Test Database
app.get('/test-database', async (req, res) => {
  try {
    console.log('\n🧪 Testing database connection...');
    
    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('id, name, phone')
      .limit(10);
    
    if (error) throw error;
    
    console.log('✅ Database connected. Tenants found:', tenants?.length || 0);
    
    res.json({
      success: true,
      message: '✅ Database connection working!',
      tenantCount: tenants?.length || 0,
      tenants: tenants
    });
  } catch (error) {
    console.error('❌ Database Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// Test full system
app.get('/test-all', async (req, res) => {
  const results = {
    twilio: '❌ Not tested',
    dedalus: '❌ Not tested', 
    database: '❌ Not tested'
  };
  
  // Test Twilio
  try {
    await twilioClient.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    results.twilio = '✅ Connected';
  } catch (error) {
    results.twilio = `❌ Error: ${error.message}`;
  }
  
  // Test Dedalus - ✅ FIXED
  try {
    await dedalus.chat.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 5
    });
    results.dedalus = '✅ Connected';
  } catch (error) {
    results.dedalus = `❌ Error: ${error.message}`;
  }
  
  // Test Database
  try {
    const { error } = await supabase.from('tenants').select('id').limit(1);
    if (error) throw error;
    results.database = '✅ Connected';
  } catch (error) {
    results.database = `❌ Error: ${error.message}`;
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
    console.log('\n' + '='.repeat(50));
    console.log('📱 NEW WHATSAPP MESSAGE RECEIVED');
    console.log('='.repeat(50));
    
    const incomingMessage = req.body.Body;
    const rawFrom = req.body.From;
    const senderPhone = rawFrom?.replace('whatsapp:', '') || rawFrom;
    
    console.log('  Message:', incomingMessage);
    console.log('  From:', senderPhone);
    
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
      twiml.message('Lo siento, no reconozco este número. Por favor contacta a tu casero directamente.');
      return res.type('text/xml').send(twiml.toString());
    }
    
    // Get AI response
    let aiResponse;
    try {
      aiResponse = await generateAIResponse(incomingMessage, tenant, tenant.properties);
    } catch (aiError) {
      console.error('❌ AI Error:', aiError.message);
      aiResponse = {
        message: 'Hola, recibí tu mensaje. El casero ha sido notificado y te responderá pronto.',
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
      } catch (notifyError) {
        console.error('❌ Notification error:', notifyError.message);
      }
    }
    
    // Send response
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiResponse.message);
    
    console.log('✅ Response sent');
    res.type('text/xml').send(twiml.toString());
    
  } catch (error) {
    console.error('❌ WEBHOOK ERROR:', error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('Disculpa, hubo un error. Por favor intenta de nuevo.');
    res.type('text/xml').send(twiml.toString());
  }
});

// ============================================
// AI RESPONSE GENERATION - ✅ FIXED
// ============================================

async function generateAIResponse(message, tenant, property) {
  const prompt = `Eres un asistente virtual amigable para inquilinos en México.

INFORMACIÓN DEL INQUILINO:
- Nombre: ${tenant.name}
- Propiedad: ${property?.address || 'Sin asignar'}
- Renta mensual: $${property?.monthly_rent || 'N/A'} MXN
- Día de pago: ${property?.rent_due_day || 'N/A'} de cada mes
- Casero: ${property?.landlord_name || 'N/A'}

MENSAJE: "${message}"

REGLAS:
1. Responde directamente si puedes (pagos, fechas, info general)
2. Solo marca needsAttention: true para emergencias reales o reparaciones
3. Sé específico usando los datos del inquilino

Responde en JSON:
{
  "message": "Tu respuesta (máximo 500 caracteres)",
  "category": "URGENTE|MANTENIMIENTO|PAGO|CONSULTA",
  "needsAttention": true o false
}`;

  try {
    // ✅ CORRECT: Use dedalus.chat.create()
    const completion = await dedalus.chat.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      response_format: { type: 'json_object' },
      max_tokens: 600
    });
    
    const response = JSON.parse(completion.choices[0].message.content);
    response.needsAttention = response.needsAttention === true;
    return response;
    
  } catch (error) {
    console.error('AI Error:', error.message);
    
    // Smart fallback
    const lowerMessage = message.toLowerCase();
    
    if (lowerMessage.includes('fuga') || lowerMessage.includes('emergencia')) {
      return {
        message: '🚨 He notificado a tu casero de inmediato sobre esta emergencia.',
        category: 'URGENTE',
        needsAttention: true
      };
    }
    
    if (lowerMessage.includes('pago') || lowerMessage.includes('renta')) {
      return {
        message: `Tu renta es de $${property?.monthly_rent || 'N/A'} MXN y vence el día ${property?.rent_due_day || 'N/A'}.`,
        category: 'PAGO',
        needsAttention: false
      };
    }
    
    return {
      message: 'Recibí tu mensaje. Te respondo en breve.',
      category: 'CONSULTA',
      needsAttention: true
    };
  }
}

async function notifyLandlord(tenant, tenantMessage, property) {
  const landlordMessage = `🚨 ATENCIÓN REQUERIDA

Inquilino: ${tenant.name}
Propiedad: ${property.address}
Mensaje: "${tenantMessage}"

Responde al inquilino: ${tenant.phone}`;
  
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: `whatsapp:${property.landlord_phone}`,
    body: landlordMessage
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
      
      const propertyIds = properties.map(p => p.id);
      
      const { data: tenants } = await supabase
        .from('tenants')
        .select('id')
        .in('property_id', propertyIds);
      
      const tenantIds = tenants.map(t => t.id);
      
      const { data: messages } = await supabase
        .from('messages')
        .select('*')
        .in('tenant_id', tenantIds)
        .gte('created_at', yesterday.toISOString());
      
      if (messages && messages.length > 0) {
        const urgentCount = messages.filter(m => m.needs_landlord_attention).length;
        
        const recap = `📊 RESUMEN DIARIO

Mensajes: ${messages.length}
Urgentes: ${urgentCount}
Dashboard: ${process.env.RAILWAY_URL || 'tu-url.railway.app'}`;
        
        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_NUMBER,
          to: `whatsapp:${landlord.phone}`,
          body: recap
        });
      }
    }
  } catch (error) {
    console.error('❌ Daily recap error:', error);
  }
}

const cron = require('node-cron');
cron.schedule('0 20 * * *', sendDailyRecap, {
  timezone: "America/Mexico_City"
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n🚀 LANDLORD AI SERVER STARTED');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🧪 Test: /test-dedalus\n`);
});