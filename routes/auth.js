const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();

// This function will be passed in from server.js
let supabase;

// Initialize the router with supabase client
function initAuthRoutes(supabaseClient) {
  supabase = supabaseClient;
  return router;
}

// GET /signup - Show the signup page
router.get('/signup', (req, res) => {
  res.render('signup', { error: null });
});

// POST /signup - Process the signup form
router.post('/signup', async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;
    
    // Hash the password (encrypt it for security)
    const password_hash = await bcrypt.hash(password, 10);
    
    // Save the landlord to database
    const { data, error } = await supabase
      .from('landlords')
      .insert([{ email, password_hash, name, phone }])
      .select()
      .single();
    
    if (error) {
      return res.render('signup', { error: 'El correo ya existe' });
    }
    
    // Save landlord to session (log them in)
    req.session.landlordId = data.id;
    req.session.landlordName = data.name;
    
    // Redirect to dashboard
    res.redirect('/dashboard');
    
  } catch (error) {
    console.error('Signup error:', error);
res.render('signup', { error: 'Algo salió mal' });
  }
});

// GET /login - Show the login page
router.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// POST /login - Process the login form
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Find landlord by email
    const { data: landlord, error } = await supabase
      .from('landlords')
      .select('*')
      .eq('email', email)
      .single();
    
    if (error || !landlord) {
     return res.render('login', { error: 'Correo o contraseña incorrectos' });
    }
    
    // Check if password matches
    const passwordMatch = await bcrypt.compare(password, landlord.password_hash);
    
    if (!passwordMatch) {
      return res.render('login', { error: 'Correo o contraseña incorrectos' });
    }
    
    // Save to session (log them in)
    req.session.landlordId = landlord.id;
    req.session.landlordName = landlord.name;
    
    // Redirect to dashboard
    res.redirect('/dashboard');
    
  } catch (error) {
    console.error('Login error:', error);
    res.render('login', { error: 'Algo salió mal' });
  }
});

// GET /logout - Log out the user
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

module.exports = initAuthRoutes;