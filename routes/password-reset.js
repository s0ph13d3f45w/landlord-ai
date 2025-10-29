const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Resend } = require('resend');
const router = express.Router();

let supabase;
const resend = new Resend(process.env.RESEND_API_KEY);

// Initialize the router with supabase client
function initPasswordResetRoutes(supabaseClient) {
  supabase = supabaseClient;
  return router;
}

// GET /forgot-password - Show forgot password page
router.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { 
    error: null, 
    success: null 
  });
});

// POST /forgot-password - Send reset email
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    // Find landlord by email
    const { data: landlord, error } = await supabase
      .from('landlords')
      .select('*')
      .eq('email', email)
      .single();
    
    // Always show success message (security: don't reveal if email exists)
    if (error || !landlord) {
      return res.render('forgot-password', { 
        error: null,
        success: 'Si el correo existe, recibirás un enlace de recuperación en unos minutos.'
      });
    }
    
    // Generate random token
    const token = crypto.randomBytes(32).toString('hex');
    
    // Set expiration (1 hour from now)
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1);
    
    // Save token to database
    await supabase
      .from('password_reset_tokens')
      .insert([{
        landlord_id: landlord.id,
        token: token,
        expires_at: expiresAt.toISOString()
      }]);
    
    // Create reset link
    const resetLink = `${process.env.RAILWAY_URL || 'http://localhost:3000'}/reset-password?token=${token}`;
    
    // Send email
    try {
      await resend.emails.send({
        from: 'Landlord AI <onboarding@resend.dev>', // Change this later to your domain
        to: email,
        subject: 'Recupera tu contraseña - Landlord AI',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #0071e3;">🏠 Landlord AI</h1>
            <h2>Recuperación de Contraseña</h2>
            <p>Hola ${landlord.name},</p>
            <p>Recibimos una solicitud para restablecer tu contraseña. Haz clic en el botón de abajo para crear una nueva contraseña:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetLink}" style="background-color: #0071e3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">Restablecer Contraseña</a>
            </div>
            <p>O copia y pega este enlace en tu navegador:</p>
            <p style="color: #666; word-break: break-all;">${resetLink}</p>
            <p style="color: #999; font-size: 14px; margin-top: 30px;">Este enlace expirará en 1 hora. Si no solicitaste restablecer tu contraseña, ignora este correo.</p>
          </div>
        `
      });
      
      console.log('✅ Password reset email sent to:', email);
    } catch (emailError) {
      console.error('❌ Error sending email:', emailError);
      // Continue anyway - we don't want to reveal if email sending failed
    }
    
    res.render('forgot-password', { 
      error: null,
      success: 'Si el correo existe, recibirás un enlace de recuperación en unos minutos.'
    });
    
  } catch (error) {
    console.error('Forgot password error:', error);
    res.render('forgot-password', { 
      error: 'Algo salió mal. Por favor intenta de nuevo.',
      success: null
    });
  }
});

// GET /reset-password - Show reset password page
router.get('/reset-password', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (!token) {
      return res.render('reset-password', { 
        error: 'Token inválido',
        token: null
      });
    }
    
    // Verify token exists and hasn't expired
    const { data: resetToken, error } = await supabase
      .from('password_reset_tokens')
      .select('*')
      .eq('token', token)
      .eq('used', false)
      .gte('expires_at', new Date().toISOString())
      .single();
    
    if (error || !resetToken) {
      return res.render('reset-password', { 
        error: 'Este enlace ha expirado o ya fue usado. Solicita uno nuevo.',
        token: null
      });
    }
    
    // Token is valid, show reset form
    res.render('reset-password', { 
      error: null,
      token: token
    });
    
  } catch (error) {
    console.error('Reset password page error:', error);
    res.render('reset-password', { 
      error: 'Algo salió mal. Por favor intenta de nuevo.',
      token: null
    });
  }
});

// POST /reset-password - Update password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password, confirm_password } = req.body;
    
    // Validate passwords match
    if (password !== confirm_password) {
      return res.render('reset-password', { 
        error: 'Las contraseñas no coinciden',
        token: token
      });
    }
    
    // Validate password length
    if (password.length < 6) {
      return res.render('reset-password', { 
        error: 'La contraseña debe tener al menos 6 caracteres',
        token: token
      });
    }
    
    // Verify token
    const { data: resetToken, error: tokenError } = await supabase
      .from('password_reset_tokens')
      .select('*')
      .eq('token', token)
      .eq('used', false)
      .gte('expires_at', new Date().toISOString())
      .single();
    
    if (tokenError || !resetToken) {
      return res.render('reset-password', { 
        error: 'Este enlace ha expirado o ya fue usado.',
        token: null
      });
    }
    
    // Hash new password
    const password_hash = await bcrypt.hash(password, 10);
    
    // Update landlord's password
    await supabase
      .from('landlords')
      .update({ password_hash })
      .eq('id', resetToken.landlord_id);
    
    // Mark token as used
    await supabase
      .from('password_reset_tokens')
      .update({ used: true })
      .eq('token', token);
    
    console.log('✅ Password reset successfully for landlord:', resetToken.landlord_id);
    
    // Redirect to login with success message
    res.render('login', { 
      error: null,
      success: '¡Contraseña restablecida exitosamente! Inicia sesión con tu nueva contraseña.'
    });
    
  } catch (error) {
    console.error('Reset password error:', error);
    res.render('reset-password', { 
      error: 'Algo salió mal. Por favor intenta de nuevo.',
      token: req.body.token
    });
  }
});

// THIS WAS MISSING! Export the function
module.exports = initPasswordResetRoutes;