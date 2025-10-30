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
app.use(express.static('public')); // Serve CSS and images

// Session middleware (for login)
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true
  }
}));

// ============================================
// DEBUGGING ENDPOINTS
// ============================================

// Test Twilio connection
app.get('/test-twilio', async (req, res) => {
  try {
    console.log('\n🧪 Testing Twilio connection...');
    console.log('Account SID:', process.env.TWILIO_ACCOUNT_SID);
    console.log('WhatsApp Number:', process.env.TWILIO_WHATSAPP_NUMBER);
    
    // IMPORTANT: Replace with YOUR phone number for testing
    const testPhone = '+525512345678'; // <-- CHANGE THIS!
    
    const message = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${testPhone}`,
      body: '🧪 Test message from Landlord AI - Twilio is working!'
    });
    
    res.send(`✅ Success! Message SID: ${message.sid}\nCheck your WhatsApp!`);
  } catch (error) {
    console.error('❌ Twilio Error:', error);
    res.status(500).send(`❌ Error: ${error.message}\n\nCheck your Twilio credentials in environment variables.`);
  }
});

// Test Dedalus AI
app.get('/test-dedalus', async (req, res) => {
  try {
    console.log('\n🧪 Testing Dedalus AI...');
    console.log('API Key present:', !!process.env.DEDALUS_API_KEY);
    
    const completion = await dedalus.chat.completions.create({
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
      tenants: tenants,
      note: 'Phone formats stored in database shown above'
    });
  } catch (error) {
    console.error('❌ Database Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      note: 'Check your SUPABASE_URL and SUPABASE_SERVICE_KEY'
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
  
  // Test Dedalus
  try {
    await dedalus.chat.completions.create({
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

// Use routes
app.use('/', initAuthRoutes(supabase));
app.use('/', initDashboardRoutes(supabase, twilioClient));
app.use('/', initPasswordResetRoutes(supabase));

// Root route - redirect to dashboard or login
app.get('/', (req, res) => {
  if (req.session.landlordId) {
    res.redirect('/dashboard');
  } else {
    res.redirect('/login');
  }
});

// ============================================
// WHATSAPP WEBHOOK - IMPROVED VERSION
// ============================================

app.post('/webhook/whatsapp', async (req, res) => {
  try {
    console.log('\n' + '='.repeat(50));
    console.log('📱 NEW WHATSAPP MESSAGE RECEIVED');
    console.log('='.repeat(50));
    console.log('📥 Full Request Body:', JSON.stringify(req.body, null, 2));
    
    const incomingMessage = req.body.Body;
    const rawFrom = req.body.From;
    const senderPhone = rawFrom?.replace('whatsapp:', '') || rawFrom;
    
    console.log('\n📊 Message Details:');
    console.log('  Raw From:', rawFrom);
    console.log('  Cleaned Phone:', senderPhone);
    console.log('  Message:', incomingMessage);
    console.log('  Message SID:', req.body.MessageSid);
    
    // Validate required fields
    if (!incomingMessage || !senderPhone) {
      console.error('❌ VALIDATION ERROR: Missing required fields');
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Error: datos incompletos');
      return res.type('text/xml').send(twiml.toString());
    }
    
    // ============================================
    // STEP 1: FIND TENANT (with multiple format attempts)
    // ============================================
    
    console.log('\n🔍 STEP 1: Looking up tenant...');
    
    let tenant = null;
    const phoneVariations = [
      senderPhone,
      senderPhone.replace('+52', ''),
      '+52' + senderPhone.replace(/^\+?52/, ''),
      senderPhone.replace(/\s+/g, '')
    ];
    
    console.log('  Trying phone variations:', phoneVariations);
    
    for (const phoneVariation of phoneVariations) {
      const { data, error } = await supabase
        .from('tenants')
        .select(`*, properties (*)`)
        .eq('phone', phoneVariation)
        .single();
      
      if (data && !error) {
        tenant = data;
        console.log(`  ✅ Found tenant with phone: ${phoneVariation}`);
        break;
      }
    }
    
    if (!tenant) {
      console.log('❌ TENANT NOT FOUND');
      
      // Debug: List all registered tenants
      const { data: allTenants } = await supabase
        .from('tenants')
        .select('name, phone');
      console.log('📋 Registered tenants in database:');
      allTenants?.forEach(t => console.log(`  - ${t.name}: ${t.phone}`));
      
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Lo siento, no reconozco este número. Por favor contacta a tu casero directamente.');
      return res.type('text/xml').send(twiml.toString());
    }
    
    console.log('✅ Tenant Details:');
    console.log('  Name:', tenant.name);
    console.log('  Property:', tenant.properties?.address || 'No property assigned');
    console.log('  Landlord:', tenant.properties?.landlord_name);
    
    // ============================================
    // STEP 2: GET AI RESPONSE
    // ============================================
    
    console.log('\n🤖 STEP 2: Requesting AI response from Dedalus...');
    
    let aiResponse;
    
    try {
      aiResponse = await generateAIResponse(incomingMessage, tenant, tenant.properties);
      
      console.log('✅ AI Response Generated:');
      console.log('  Message:', aiResponse.message);
      console.log('  Category:', aiResponse.category);
      console.log('  Needs Attention:', aiResponse.needsAttention);
      
    } catch (aiError) {
      console.error('❌ DEDALUS AI ERROR:');
      console.error('  Error:', aiError.message);
      console.error('  Stack:', aiError.stack);
      
      // Fallback response
      aiResponse = {
        message: 'Hola, recibí tu mensaje. El casero ha sido notificado y te responderá pronto.',
        category: 'CONSULTA',
        needsAttention: true
      };
      
      console.log('⚠️  Using fallback response');
    }
    
    // ============================================
    // STEP 3: SAVE TO DATABASE
    // ============================================
    
    console.log('\n💾 STEP 3: Saving message to database...');
    
    const { error: dbError } = await supabase.from('messages').insert([{
      tenant_id: tenant.id,
      direction: 'incoming',
      message_body: incomingMessage,
      category: aiResponse.category,
      ai_response: aiResponse.message,
      needs_landlord_attention: aiResponse.needsAttention
    }]);
    
    if (dbError) {
      console.error('❌ DATABASE ERROR:', dbError);
    } else {
      console.log('✅ Message saved successfully');
    }
    
    // ============================================
    // STEP 4: NOTIFY LANDLORD IF URGENT
    // ============================================
    
    if (aiResponse.needsAttention) {
      console.log('\n📲 STEP 4: Notifying landlord (urgent message)...');
      
      try {
        await notifyLandlord(tenant, incomingMessage, tenant.properties);
        console.log('✅ Landlord notified successfully');
      } catch (notifyError) {
        console.error('❌ LANDLORD NOTIFICATION ERROR:', notifyError.message);
      }
    } else {
      console.log('\n✅ STEP 4: No landlord notification needed');
    }
    
    // ============================================
    // STEP 5: SEND RESPONSE TO TENANT
    // ============================================
    
    console.log('\n📤 STEP 5: Sending response to tenant...');
    
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiResponse.message);
    
    const responseXml = twiml.toString();
    console.log('Response XML length:', responseXml.length, 'chars');
    
    console.log('\n' + '='.repeat(50));
    console.log('✅ WEBHOOK PROCESSING COMPLETE');
    console.log('='.repeat(50) + '\n');
    
    res.type('text/xml').send(responseXml);
    
  } catch (error) {
    console.error('\n' + '='.repeat(50));
    console.error('❌ CRITICAL WEBHOOK ERROR');
    console.error('='.repeat(50));
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('='.repeat(50) + '\n');
    
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('Disculpa, hubo un error. Por favor intenta de nuevo.');
    res.type('text/xml').send(twiml.toString());
  }
});

// ============================================
// AI RESPONSE GENERATION
// ============================================

async function generateAIResponse(message, tenant, property) {
  const prompt = `Eres un asistente virtual para caseros en México. Responde al inquilino de manera útil y profesional.

INFORMACIÓN DEL INQUILINO:
- Nombre: ${tenant.name}
- Propiedad: ${property?.address || 'Sin asignar'}
- Renta mensual: $${property?.monthly_rent || 'N/A'} MXN
- Día de pago: ${property?.rent_due_day || 'N/A'} de cada mes
- Casero: ${property?.landlord_name || 'N/A'}
- Instrucciones especiales: ${property?.special_instructions || 'Ninguna'}

MENSAJE DEL INQUILINO:
"${message}"

INSTRUCCIONES IMPORTANTES:
1. SÉ PROACTIVO Y ÚTIL - Da soluciones e instrucciones paso a paso
2. RESUELVE DIRECTAMENTE - Si puedes responder sin involucrar al casero, hazlo
3. DA INSTRUCCIONES CLARAS - Explica QUÉ hacer y CÓMO hacerlo
4. USA EJEMPLOS - Si hablas de pagos, da ejemplos con números reales

CATEGORÍAS Y CUÁNDO INVOLUCRAR AL CASERO:
- URGENTE (needsAttention: true): Fugas, emergencias, seguridad
- MANTENIMIENTO (needsAttention: true si necesita profesional): Reparaciones
- PAGO (needsAttention: false excepto prórroga): Dudas sobre pagos
- CONSULTA (needsAttention: false): Información general

Responde en formato JSON:
{
  "message": "tu respuesta ÚTIL aquí (máximo 400 caracteres, da instrucciones claras)",
  "category": "URGENTE o MANTENIMIENTO o PAGO o CONSULTA",
  "needsAttention": true solo si REALMENTE necesita al casero, false si puedes ayudar directamente
}`;

  console.log('  Sending prompt to Dedalus (length:', prompt.length, 'chars)');

  const completion = await dedalus.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    response_format: { type: 'json_object' }
  });
  
  const responseText = completion.choices[0].message.content;
  console.log('  Raw AI response:', responseText);
  
  const response = JSON.parse(responseText);
  return response;
}

// ============================================
// NOTIFY LANDLORD
// ============================================

async function notifyLandlord(tenant, tenantMessage, property) {
  const landlordMessage = `🚨 ATENCIÓN REQUERIDA

Inquilino: ${tenant.name}
Propiedad: ${property.address}

Mensaje: "${tenantMessage}"

Por favor responde directamente al inquilino: ${tenant.phone}`;
  
  console.log('  Sending notification to:', property.landlord_phone);
  
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: `whatsapp:${property.landlord_phone}`,
    body: landlordMessage
  });
}

// ============================================
// DAILY RECAP
// ============================================

async function sendDailyRecap() {
  try {
    console.log('\n📊 Sending daily recaps...');
    
    const { data: landlords } = await supabase
      .from('landlords')
      .select('*');
    
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
        const totalCount = messages.length;
        
        const recap = `📊 RESUMEN DIARIO

Total de mensajes: ${totalCount}
Requieren atención: ${urgentCount}
Resueltos por AI: ${totalCount - urgentCount}

Ve los detalles en tu dashboard: ${process.env.RAILWAY_URL || 'tu-url.railway.app'}`;
        
        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_NUMBER,
          to: `whatsapp:${landlord.phone}`,
          body: recap
        });
        
        console.log(`✅ Daily recap sent to ${landlord.name}`);
      }
    }
  } catch (error) {
    console.error('❌ Error sending daily recap:', error);
  }
}

// Schedule daily recap at 8 PM Mexico City time
const cron = require('node-cron');
cron.schedule('0 20 * * *', sendDailyRecap, {
  timezone: "America/Mexico_City"
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(50));
  console.log('🚀 LANDLORD AI SERVER STARTED');
  console.log('='.repeat(50));
  console.log(`📡 Port: ${PORT}`);
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
  console.log(`📱 Webhook: http://localhost:${PORT}/webhook/whatsapp`);
  console.log('\n🧪 Test endpoints:');
  console.log(`  - /test-twilio`);
  console.log(`  - /test-dedalus`);
  console.log(`  - /test-database`);
  console.log(`  - /test-all`);
  console.log('='.repeat(50) + '\n');
});