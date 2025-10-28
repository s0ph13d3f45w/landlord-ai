const express = require('express');
const router = express.Router();

let supabase;
let twilioClient;

// Initialize with services from server.js
function initDashboardRoutes(supabaseClient, twilio) {
  supabase = supabaseClient;
  twilioClient = twilio;
  return router;
}

// Middleware: Check if user is logged in
function requireLogin(req, res, next) {
  if (!req.session.landlordId) {
    return res.redirect('/login');
  }
  next();
}

// GET /dashboard - Main dashboard page
router.get('/dashboard', requireLogin, async (req, res) => {
  try {
    const landlordId = req.session.landlordId;
    
    // Get landlord's properties
    const { data: properties } = await supabase
      .from('properties')
      .select('*')
      .eq('landlord_id', landlordId);
    
    // Get all tenants for these properties
    const { data: tenants } = await supabase
      .from('tenants')
      .select(`
        *,
        properties (address)
      `)
      .in('property_id', properties?.map(p => p.id) || []);
    
    // Get recent messages
    const { data: messages } = await supabase
      .from('messages')
      .select(`
        *,
        tenants (name, phone, properties (address))
      `)
      .in('tenant_id', tenants?.map(t => t.id) || [])
      .order('created_at', { ascending: false })
      .limit(50);
    
    res.render('dashboard', {
      landlordName: req.session.landlordName,
      properties: properties || [],
      tenants: tenants || [],
      messages: messages || []
    });
    
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send('Error loading dashboard');
  }
});

// GET /dashboard/properties - Manage properties
router.get('/dashboard/properties', requireLogin, async (req, res) => {
  try {
    const { data: properties } = await supabase
      .from('properties')
      .select('*, tenants (count)')
      .eq('landlord_id', req.session.landlordId);
    
    res.render('properties', {
      landlordName: req.session.landlordName,
      properties: properties || []
    });
  } catch (error) {
    console.error('Properties error:', error);
    res.status(500).send('Error loading properties');
  }
});

// POST /dashboard/properties/add - Add new property
router.post('/dashboard/properties/add', requireLogin, async (req, res) => {
  try {
    const { address, monthly_rent, rent_due_day, special_instructions } = req.body;
    const landlordId = req.session.landlordId;
    
    // Get landlord's phone from database
    const { data: landlord } = await supabase
      .from('landlords')
      .select('phone, name')
      .eq('id', landlordId)
      .single();
    
    await supabase
      .from('properties')
      .insert([{
        address,
        monthly_rent: parseFloat(monthly_rent),
        rent_due_day: parseInt(rent_due_day),
        special_instructions,
        landlord_id: landlordId,
        landlord_phone: landlord.phone,
        landlord_name: landlord.name
      }]);
    
    res.redirect('/dashboard/properties');
  } catch (error) {
    console.error('Add property error:', error);
    res.status(500).send('Error adding property');
  }
});

// POST /dashboard/tenants/add - Add new tenant
router.post('/dashboard/tenants/add', requireLogin, async (req, res) => {
  try {
    const { name, phone, property_id, move_in_date } = req.body;
    
    await supabase
      .from('tenants')
      .insert([{
        name,
        phone,
        property_id,
        move_in_date
      }]);
    
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Add tenant error:', error);
    res.status(500).send('Error adding tenant');
  }
});

// POST /dashboard/reply - Reply to a tenant
router.post('/dashboard/reply', requireLogin, async (req, res) => {
  try {
    const { tenant_phone, message } = req.body;
    
    // Send WhatsApp message via Twilio
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:${tenant_phone}`,
      body: message
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Reply error:', error);
    res.json({ success: false, error: error.message });
  }
});

module.exports = initDashboardRoutes;