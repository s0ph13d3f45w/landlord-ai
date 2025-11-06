import os
from flask import Flask, request, session, redirect, render_template
from twilio.twiml.messaging_response import MessagingResponse
from twilio.rest import Client
from supabase import create_client, Client as SupabaseClient
from dedalus import Dedalus
import json
from datetime import datetime, timedelta

app = Flask(__name__)
app.secret_key = os.environ.get('SESSION_SECRET', 'your-secret-key')

# Initialize services
dedalus_client = Dedalus(api_key=os.environ.get('DEDALUS_API_KEY'))
supabase: SupabaseClient = create_client(
    os.environ.get('SUPABASE_URL'),
    os.environ.get('SUPABASE_SERVICE_KEY')
)
twilio_client = Client(
    os.environ.get('TWILIO_ACCOUNT_SID'),
    os.environ.get('TWILIO_AUTH_TOKEN')
)

print("✅ All services initialized")

# Test endpoint
@app.route('/test-dedalus')
def test_dedalus():
    try:
        response = dedalus_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": "Say 'Dedalus works!'"}]
        )
        return f"✅ Dedalus working!\n\n{response.choices[0].message.content}"
    except Exception as e:
        return f"❌ Error: {str(e)}", 500

@app.route('/test-database')
def test_database():
    try:
        response = supabase.table('tenants').select('id, name, phone').limit(10).execute()
        return {
            'success': True,
            'tenant_count': len(response.data),
            'tenants': response.data
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}, 500

# WhatsApp webhook
@app.route('/webhook/whatsapp', methods=['POST'])
def whatsapp_webhook():
    try:
        incoming_message = request.form.get('Body')
        raw_from = request.form.get('From')
        sender_phone = raw_from.replace('whatsapp:', '') if raw_from else None
        
        print(f"📱 Message from {sender_phone}: {incoming_message}")
        
        if not incoming_message or not sender_phone:
            resp = MessagingResponse()
            resp.message('Error: datos incompletos')
            return str(resp)
        
        # Find tenant
        tenant = None
        phone_variations = [
            sender_phone,
            sender_phone.replace('+52', ''),
            '+52' + sender_phone.replace('+52', '').replace('+', ''),
            sender_phone.replace(' ', '')
        ]
        
        for phone in phone_variations:
            try:
                result = supabase.table('tenants').select('*, properties(*)').eq('phone', phone).single().execute()
                if result.data:
                    tenant = result.data
                    break
            except:
                continue
        
        if not tenant:
            print(f"❌ Tenant not found for {sender_phone}")
            resp = MessagingResponse()
            resp.message('Lo siento, no reconozco este número.')
            return str(resp)
        
        print(f"✅ Found tenant: {tenant['name']}")
        
        # Get AI response
        try:
            ai_response = generate_ai_response(incoming_message, tenant)
        except Exception as e:
            print(f"❌ AI error: {e}")
            ai_response = {
                'message': 'Hola, recibí tu mensaje. El casero responderá pronto.',
                'category': 'CONSULTA',
                'needsAttention': True
            }
        
        # Save to database
        supabase.table('messages').insert({
            'tenant_id': tenant['id'],
            'direction': 'incoming',
            'message_body': incoming_message,
            'category': ai_response['category'],
            'ai_response': ai_response['message'],
            'needs_landlord_attention': ai_response['needsAttention']
        }).execute()
        
        # Notify landlord if urgent
        if ai_response['needsAttention'] and tenant.get('properties', {}).get('landlord_phone'):
            try:
                twilio_client.messages.create(
                    from_=os.environ.get('TWILIO_WHATSAPP_NUMBER'),
                    to=f"whatsapp:{tenant['properties']['landlord_phone']}",
                    body=f"🚨 {tenant['name']}: \"{incoming_message}\""
                )
            except Exception as e:
                print(f"❌ Notification error: {e}")
        
        # Send response
        resp = MessagingResponse()
        resp.message(ai_response['message'])
        return str(resp)
        
    except Exception as e:
        print(f"❌ Webhook error: {e}")
        resp = MessagingResponse()
        resp.message('Disculpa, hubo un error.')
        return str(resp)

def generate_ai_response(message, tenant):
    """Generate AI response using Dedalus"""
    property_info = tenant.get('properties', {})
    
    prompt = f"""Eres un asistente virtual para inquilinos en México.

INFORMACIÓN:
- Inquilino: {tenant['name']}
- Propiedad: {property_info.get('address', 'N/A')}
- Renta: ${property_info.get('monthly_rent', 'N/A')} MXN
- Día de pago: {property_info.get('rent_due_day', 'N/A')}
- Casero: {property_info.get('landlord_name', 'N/A')}

MENSAJE: "{message}"

Responde directamente si puedes. Solo marca needsAttention: true para emergencias o reparaciones.

Responde en JSON:
{{
  "message": "Tu respuesta (máximo 400 caracteres)",
  "category": "URGENTE|MANTENIMIENTO|PAGO|CONSULTA",
  "needsAttention": true o false
}}"""
    
    try:
        response = dedalus_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "You are a helpful assistant that responds in JSON."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.7
        )
        
        result = json.loads(response.choices[0].message.content)
        result['needsAttention'] = result.get('needsAttention', True)
        return result
        
    except Exception as e:
        print(f"AI generation error: {e}")
        
        # Smart fallback
        lower = message.lower()
        
        if 'fuga' in lower or 'emergencia' in lower:
            return {
                'message': '🚨 He notificado a tu casero sobre esta emergencia.',
                'category': 'URGENTE',
                'needsAttention': True
            }
        
        if 'pago' in lower or 'renta' in lower:
            return {
                'message': f"Tu renta es ${property_info.get('monthly_rent', 'N/A')} MXN, vence el día {property_info.get('rent_due_day', 'N/A')}.",
                'category': 'PAGO',
                'needsAttention': False
            }
        
        return {
            'message': 'Recibí tu mensaje. Te respondo pronto.',
            'category': 'CONSULTA',
            'needsAttention': True
        }

# Import and register other routes
try:
    from routes.auth import auth_bp
    from routes.dashboard import dashboard_bp
    from routes.password_reset import password_reset_bp
    
    app.register_blueprint(auth_bp)
    app.register_blueprint(dashboard_bp)
    app.register_blueprint(password_reset_bp)
except ImportError as e:
    print(f"⚠️  Could not import routes: {e}")

@app.route('/')
def index():
    if session.get('landlord_id'):
        return redirect('/dashboard')
    return redirect('/login')

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 3000))
    app.run(host='0.0.0.0', port=port)
    print(f"🚀 Server running on port {port}")
