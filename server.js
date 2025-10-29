require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const twilio = require('twilio');
const { Dedalus } = require('dedalus-labs');
const { createClient } = require('@supabase/supabase-js');

// Initialize Express app
const app = express();

// Initialize services
const dedalus = new Dedalus({ apiKey: process.env.DEDALUS_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

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

// Import routes
const initAuthRoutes = require('./routes/auth');
const initDashboardRoutes = require('./routes/dashboard');
const initPasswordResetRoutes = require('./routes/password-reset');
// Use routes
app.use('/', initAuthRoutes(supabase));
app.use('/', initDashboardRoutes(supabase, twilioClient));
app.use('/', initPasswordResetRoutes(supabase));

RAILWAY_URL=https://https://web-production-d8745.up.railway.app/
// Root route - redirect to dashboard or login
app.get('/', (req, res) => {
  if (req.session.landlordId) {
    res.redirect('/dashboard');
  } else {
    res.redirect('/login');
  }
});

// WhatsApp webhook - receives messages from tenants
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const incomingMessage = req.body.Body;
    const senderPhone = req.body.From.replace('whatsapp:', '');
    
    console.log('\n📱 NEW MESSAGE');
    console.log('From:', senderPhone);
    console.log('Message:', incomingMessage);
    
    // Look up tenant
    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .select(`
        *,
        properties (*)
      `)
      .eq('phone', senderPhone)
      .single();
    
    if (tenantError || !tenant) {
      console.log('❌ Unknown number');
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Lo siento, no reconozco este número. Por favor contacta a tu casero directamente.');
      return res.type('text/xml').send(twiml.toString());
    }
    
    console.log('✅ Tenant found:', tenant.name);
    
    // Get AI response
    const aiResponse = await generateAIResponse(incomingMessage, tenant, tenant.properties);
    
    console.log('🤖 AI Response:', aiResponse.message);
    console.log('📊 Category:', aiResponse.category);
    console.log('⚠️  Needs attention:', aiResponse.needsAttention);
    
    // Save message to database
    await supabase.from('messages').insert([{
      tenant_id: tenant.id,
      direction: 'incoming',
      message_body: incomingMessage,
      category: aiResponse.category,
      ai_response: aiResponse.message,
      needs_landlord_attention: aiResponse.needsAttention
    }]);
    
    // If urgent, notify landlord via WhatsApp
    if (aiResponse.needsAttention) {
      await notifyLandlord(tenant, incomingMessage, tenant.properties);
    }
    
    // Send response back to tenant
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiResponse.message);
    res.type('text/xml').send(twiml.toString());
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('Disculpa, hubo un error. Por favor intenta de nuevo.');
    res.type('text/xml').send(twiml.toString());
  }
});

// Generate AI response function
async function generateAIResponse(message, tenant, property) {
  const prompt = `Eres un asistente virtual para caseros en México. Responde al inquilino de manera útil y profesional.

INFORMACIÓN DEL INQUILINO:
- Nombre: ${tenant.name}
- Propiedad: ${property.address}
- Renta mensual: $${property.monthly_rent} MXN
- Día de pago: ${property.rent_due_day} de cada mes
- Casero: ${property.landlord_name}
- Instrucciones especiales: ${property.special_instructions || 'Ninguna'}

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

  const completion = await dedalus.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    response_format: { type: 'json_object' }
  });
  
  const response = JSON.parse(completion.choices[0].message.content);
  return response;
}

// Notify landlord function
async function notifyLandlord(tenant, tenantMessage, property) {
  const landlordMessage = `🚨 ATENCIÓN REQUERIDA

Inquilino: ${tenant.name}
Propiedad: ${property.address}

Mensaje: "${tenantMessage}"

Por favor responde directamente al inquilino: ${tenant.phone}`;
  
  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${property.landlord_phone}`,
      body: landlordMessage
    });
    console.log('📲 Landlord notified');
  } catch (error) {
    console.error('❌ Failed to notify landlord:', error);
  }
}

// Daily recap function (we'll set this up with a cron job later)
async function sendDailyRecap() {
  try {
    // Get all landlords
    const { data: landlords } = await supabase
      .from('landlords')
      .select('*');
    
    for (const landlord of landlords) {
      // Get messages from last 24 hours for this landlord's properties
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
        
        console.log(`📲 Daily recap sent to ${landlord.name}`);
      }
    }
  } catch (error) {
    console.error('❌ Error sending daily recap:', error);
  }
}

// Schedule daily recap at 8 PM Mexico City time
// We'll add node-cron for this
const cron = require('node-cron');
cron.schedule('0 20 * * *', sendDailyRecap, {
  timezone: "America/Mexico_City"
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Server running on port ${PORT}`);
  console.log('💬 Dashboard ready!\n');
});