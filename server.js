require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

// Initialize services
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Middleware
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check endpoint
// Serve dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(__dirname + '/dashboard.html');
});


// WhatsApp webhook - receives messages
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const incomingMessage = req.body.Body;
    const senderPhone = req.body.From.replace('whatsapp:', '');
    
    console.log('\n📱 NEW MESSAGE');
    console.log('From:', senderPhone);
    console.log('Message:', incomingMessage);
    
    // Look up tenant by phone
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
    
    // Save incoming message
    await supabase.from('messages').insert({
      tenant_id: tenant.id,
      direction: 'incoming',
      message_body: incomingMessage
    });
    
    // Generate AI response
    const aiResponse = await generateAIResponse(incomingMessage, tenant);
    
    console.log('🤖 AI Response:', aiResponse.message);
    console.log('📊 Category:', aiResponse.category);
    console.log('⚠️  Needs attention:', aiResponse.needsAttention);
    
    // Save AI response
    await supabase.from('messages').insert({
      tenant_id: tenant.id,
      direction: 'outgoing',
      message_body: aiResponse.message,
      category: aiResponse.category,
      ai_response: aiResponse.message,
      needs_landlord_attention: aiResponse.needsAttention
    });
    
    // If urgent, notify landlord
    if (aiResponse.needsAttention) {
      await notifyLandlord(tenant, incomingMessage);
    }
    
    // Send response to tenant
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(aiResponse.message);
    res.type('text/xml').send(twiml.toString());
    
  } catch (error) {
    console.error('❌ Error:', error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('Disculpa, hubo un error. Por favor intenta de nuevo.');
    res.type('text/xml').send(twiml.toString());
  }
});

// Generate AI response based on tenant message
async function generateAIResponse(message, tenant) {
  const property = tenant.properties;
  
  const prompt = `Eres un asistente virtual para inquilinos en México. Responde en español de manera amigable y profesional.

INFORMACIÓN DEL INQUILINO:
- Nombre: ${tenant.name}
- Propiedad: ${property.address}
- Renta mensual: $${property.monthly_rent} MXN
- Día de pago: ${property.rent_due_day} de cada mes
- Casero: ${property.landlord_name}
- Instrucciones especiales: ${property.special_instructions || 'Ninguna'}

MENSAJE DEL INQUILINO:
"${message}"

INSTRUCCIONES:
1. Responde de manera útil y amigable
2. Si es sobre mantenimiento urgente (fuga, incendio, emergencia) → marca como URGENTE
3. Si es sobre mantenimiento normal → marca como MANTENIMIENTO
4. Si es sobre pagos → marca como PAGO
5. Si es pregunta general → marca como CONSULTA

Responde en formato JSON:
{
  "message": "tu respuesta aquí (máximo 300 caracteres para WhatsApp)",
  "category": "URGENTE o MANTENIMIENTO o PAGO o CONSULTA",
  "needsAttention": true si requiere atención del casero, false si no
}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    response_format: { type: 'json_object' }
  });
  
  const response = JSON.parse(completion.choices[0].message.content);
  return response;
}

// Notify landlord of urgent issues
async function notifyLandlord(tenant, tenantMessage) {
  const property = tenant.properties;
  const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  
  const landlordMessage = `🚨 ATENCIÓN REQUERIDA

Inquilino: ${tenant.name}
Propiedad: ${property.address}

Mensaje: "${tenantMessage}"

Por favor responde directamente al inquilino.`;
  
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
// Dashboard API - Get all messages
app.get('/api/messages', async (req, res) => {
  try {
    const { data: messages, error } = await supabase
      .from('messages')
      .select(`
        *,
        tenants (
          name,
          phone,
          properties (
            address,
            landlord_name
          )
        )
      `)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json({ success: true, messages });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Dashboard API - Get urgent messages only
app.get('/api/messages/urgent', async (req, res) => {
  try {
    const { data: messages, error } = await supabase
      .from('messages')
      .select(`
        *,
        tenants (
          name,
          phone,
          properties (
            address,
            landlord_name
          )
        )
      `)
      .eq('needs_landlord_attention', true)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    res.json({ success: true, messages });
  } catch (error) {
    console.error('Error fetching urgent messages:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Dashboard API - Get stats
app.get('/api/stats', async (req, res) => {
  try {
    const { data: totalMessages } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true });
    
    const { data: urgentMessages } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('needs_landlord_attention', true);
    
    const { data: properties } = await supabase
      .from('properties')
      .select('id', { count: 'exact', head: true });

    const { data: tenants } = await supabase
      .from('tenants')
      .select('id', { count: 'exact', head: true });

    res.json({
      success: true,
      stats: {
        totalMessages: totalMessages || 0,
        urgentMessages: urgentMessages || 0,
        properties: properties || 0,
        tenants: tenants || 0
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
  
});
// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Server running on port ${PORT}`);
  console.log('💬 Ready to receive WhatsApp messages!\n');
});