// api/index.js - Main backend server for Vercel deployment
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Initialize Resend client
const resend = new Resend(process.env.RESEND_API_KEY);

// Helper function to send CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Main handler function for Vercel serverless
export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).json({ success: true });
  }

  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  // Route: Health check
  if (pathname === '/api/health' && req.method === 'GET') {
    return res.status(200).json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString() 
    });
  }

  // Route: GHL Webhook - Process winner
  if (pathname === '/api/webhook/winner' && req.method === 'POST') {
    try {
      const { contact_id, first_name, last_name, email, certification_type } = req.body;

      // Validation
      if (!email || !certification_type) {
        return res.status(400).json({ 
          error: 'Missing required fields: email and certification_type' 
        });
      }

      // Step 1: Find next available class
      const { data: classData, error: classError } = await supabase
        .from('classes')
        .select('*')
        .eq('certification_type', certification_type)
        .gte('class_date', new Date().toISOString().split('T')[0])
        .order('class_date', { ascending: true })
        .limit(1)
        .single();

      if (classError || !classData) {
        // No class available - notify admin
        await sendAdminAlert(
          'No Classes Available',
          `No upcoming ${certification_type} classes found for winner: ${email}`
        );
        
        return res.status(404).json({ 
          error: 'No upcoming classes available',
          certification_type 
        });
      }

      // Step 2: Find available voucher
      const { data: voucherData, error: voucherError } = await supabase
        .from('vouchers')
        .select('*')
        .eq('certification_type', certification_type)
        .eq('status', 'Available')
        .limit(1)
        .single();

      if (voucherError || !voucherData) {
        // No voucher available - notify admin
        await sendAdminAlert(
          'No Vouchers Available',
          `No available ${certification_type} vouchers for winner: ${email}`
        );
        
        return res.status(404).json({ 
          error: 'No vouchers available',
          certification_type 
        });
      }

      // Step 3: Send winner email
      const emailSent = await sendWinnerEmail({
        to: email,
        winner_name: `${first_name} ${last_name}`,
        certification_type,
        class_date: classData.class_date,
        class_time: classData.class_time,
        location_format: classData.location_format,
        instructor_name: classData.instructor_name,
        registration_link: classData.registration_link,
        voucher_code: voucherData.voucher_code
      });

      if (!emailSent) {
        return res.status(500).json({ error: 'Failed to send email' });
      }

      // Step 4: Mark voucher as used
      const { error: updateError } = await supabase
        .from('vouchers')
        .update({
          status: 'Used',
          winner_name: `${first_name} ${last_name}`,
          winner_email: email,
          date_issued: new Date().toISOString()
        })
        .eq('id', voucherData.id);

      if (updateError) {
        console.error('Voucher update failed:', updateError);
      }

      // Step 5: Log distribution
      await supabase.from('distributions').insert({
        winner_name: `${first_name} ${last_name}`,
        winner_email: email,
        certification_type,
        voucher_code: voucherData.voucher_code,
        class_date: classData.class_date,
        date_issued: new Date().toISOString(),
        status: 'Sent',
        ghl_contact_id: contact_id
      });

      return res.status(200).json({
        success: true,
        message: 'Voucher processed successfully',
        data: {
          voucher_code: voucherData.voucher_code,
          class_date: classData.class_date,
          email_sent: true
        }
      });

    } catch (error) {
      console.error('Webhook processing error:', error);
      return res.status(500).json({ 
        error: 'Internal server error',
        details: error.message 
      });
    }
  }

  // Route: Get all classes
  if (pathname === '/api/classes' && req.method === 'GET') {
    const { data, error } = await supabase
      .from('classes')
      .select('*')
      .order('class_date', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json(data);
  }

  // Route: Add new class
  if (pathname === '/api/classes' && req.method === 'POST') {
    const { data, error } = await supabase
      .from('classes')
      .insert(req.body)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json(data);
  }

  // Route: Get all vouchers
  if (pathname === '/api/vouchers' && req.method === 'GET') {
    const { data, error } = await supabase
      .from('vouchers')
      .select('*')
      .order('certification_type', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json(data);
  }

  // Route: Add new voucher
  if (pathname === '/api/vouchers' && req.method === 'POST') {
    const { data, error } = await supabase
      .from('vouchers')
      .insert({
        ...req.body,
        status: 'Available'
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json(data);
  }

  // Route: Get distribution history
  if (pathname === '/api/distributions' && req.method === 'GET') {
    const { data, error } = await supabase
      .from('distributions')
      .select('*')
      .order('date_issued', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json(data);
  }

  // Route: Get statistics
  if (pathname === '/api/stats' && req.method === 'GET') {
    const [vouchersResult, classesResult, distributionsResult] = await Promise.all([
      supabase.from('vouchers').select('status'),
      supabase.from('classes').select('class_date'),
      supabase.from('distributions').select('id')
    ]);

    const availableVouchers = vouchersResult.data?.filter(v => v.status === 'Available').length || 0;
    const usedVouchers = vouchersResult.data?.filter(v => v.status === 'Used').length || 0;
    const upcomingClasses = classesResult.data?.filter(
      c => new Date(c.class_date) > new Date()
    ).length || 0;
    const totalDistributions = distributionsResult.data?.length || 0;

    return res.status(200).json({
      availableVouchers,
      usedVouchers,
      upcomingClasses,
      totalDistributions
    });
  }

  // 404 for unknown routes
  return res.status(404).json({ error: 'Route not found' });
}

// Email sending function
async function sendWinnerEmail(details) {
  try {
    const { data, error } = await resend.emails.send({
      from: process.env.FROM_EMAIL || 'vouchers@yourdomain.com',
      to: details.to,
      subject: `Your ${details.certification_type} Certification Voucher`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1e293b;">Congratulations ${details.winner_name}!</h2>
          
          <p>You won a ${details.certification_type} certification voucher at our seminar.</p>
          
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #475569;">Class Details</h3>
            <p><strong>Date:</strong> ${details.class_date}</p>
            <p><strong>Time:</strong> ${details.class_time}</p>
            <p><strong>Location:</strong> ${details.location_format}</p>
            <p><strong>Instructor:</strong> ${details.instructor_name}</p>
          </div>
          
          <div style="background: #eff6ff; padding: 20px; border-radius: 8px; margin: 20px 0; border: 2px solid #3b82f6;">
            <h3 style="margin-top: 0; color: #1e40af;">Your Voucher Code</h3>
            <p style="font-size: 24px; font-weight: bold; color: #1e40af; font-family: monospace;">${details.voucher_code}</p>
          </div>
          
          <p>
            <a href="${details.registration_link}" 
               style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
              Register for Class
            </a>
          </p>
          
          <p style="color: #64748b; font-size: 14px; margin-top: 30px;">
            Questions? Reply to this email and we'll help you out.
          </p>
        </div>
      `
    });

    if (error) {
      console.error('Email send error:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Email sending failed:', error);
    return false;
  }
}

// Admin alert function
async function sendAdminAlert(subject, message) {
  try {
    await resend.emails.send({
      from: process.env.FROM_EMAIL || 'alerts@yourdomain.com',
      to: process.env.ADMIN_EMAIL,
      subject: `[ALERT] ${subject}`,
      html: `
        <div style="font-family: Arial, sans-serif;">
          <h2 style="color: #dc2626;">System Alert</h2>
          <p>${message}</p>
          <p style="color: #64748b; font-size: 14px;">
            Time: ${new Date().toISOString()}
          </p>
        </div>
      `
    });
  } catch (error) {
    console.error('Admin alert failed:', error);
  }
}
