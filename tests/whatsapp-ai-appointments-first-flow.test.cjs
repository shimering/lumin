const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const webhookContent = fs.readFileSync(path.join(root, 'supabase', 'functions', 'whatsapp-webhook', 'index.ts'), 'utf8');

test('systemInstruction defines CRITICAL CONVERSATION FLOW section requiring available appointments first for cause of appointment', () => {
  assert.match(
    webhookContent,
    /CRITICAL CONVERSATION FLOW - AVAILABLE APPOINTMENTS FIRST FOR CAUSE, THEN NAME & NUMBER:/
  );
  assert.match(
    webhookContent,
    /STEP 1 \(ALWAYS FIRST\) - GIVE THE CUSTOMER THE AVAILABLE APPOINTMENTS FIRST FOR WHAT HE ASKS \(CAUSE OF APPOINTMENT\):/
  );
  assert.match(
    webhookContent,
    /Immediately identify what the customer is asking for \(the cause of the appointment \/ reason \/ complaint \/ procedure/
  );
  assert.match(
    webhookContent,
    /YOU MUST PRESENT THE AVAILABLE APPOINTMENT SLOTS FIRST TO THE CUSTOMER in your response!/
  );
});

test('systemInstruction strictly prohibits asking for name or phone number before presenting available appointments', () => {
  assert.match(
    webhookContent,
    /NEVER ask the customer for their name or phone number BEFORE providing the available appointment options!/
  );
  assert.match(
    webhookContent,
    /DO NOT send a response that only asks "What is your name and phone number\?" or delays showing appointments until they provide personal information\./
  );
  assert.match(
    webhookContent,
    /The customer must ALWAYS receive the available appointment times for their cause\/request first\./
  );
});

test('systemInstruction mandates asking for name and phone number in STEP 2 after offering slots', () => {
  assert.match(
    webhookContent,
    /STEP 2 \(THEN\) - ASK FOR THEIR NAME AND PHONE NUMBER:/
  );
  assert.match(
    webhookContent,
    /AFTER \(or alongside\) presenting the available appointment options for the requested cause:/
  );
  assert.match(
    webhookContent,
    /ask them for their full name and mobile phone number to confirm the reservation and register their file/
  );
});

test('unregistered and masked patient contexts enforce mandatory appointments-first booking order', () => {
  // Masked BSUID context
  assert.match(
    webhookContent,
    /MANDATORY BOOKING ORDER: When this patient asks for an appointment or states what they need \(cause of appointment\), ALWAYS give the available appointments first for that cause\. THEN ask for their full name and mobile phone number to confirm the booking\./
  );

  // Unregistered phone context
  assert.match(
    webhookContent,
    /MANDATORY BOOKING ORDER: When they ask to book an appointment or mention their dental issue \(cause of appointment\):/
  );
  assert.match(
    webhookContent,
    /FIRST: Give them the available appointments for what they ask \(call \\?`check_available_slots\\?` and present convenient vacant slots\)\./
  );
  assert.match(
    webhookContent,
    /THEN: Ask for their full name and mobile phone number \(or confirm this mobile number\) to complete the booking\./
  );
  assert.match(
    webhookContent,
    /NEVER ask for their name or number before presenting the available appointment slots for what they asked!/
  );
});

test('General Rules enforces appointment inquiries and booking flow with appointments first', () => {
  assert.match(
    webhookContent,
    /2\. Appointment Inquiries & Booking Flow:/
  );
  assert.match(
    webhookContent,
    /ALWAYS give the customer the available appointments FIRST for what he asks \(the cause of appointment\)\. NEVER ask for their name or phone number before giving the available appointment times!/
  );
  assert.match(
    webhookContent,
    /AFTER presenting the available appointments, ask them for their full name and mobile phone number \(or confirm their existing registered profile\) to finalize the booking\./
  );
});
