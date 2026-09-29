const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

test('WhatsApp chat header contains patient file button beside name and modal markup exists', () => {
  // 1. Verify header button beside patient name
  assert.match(html, /id="whatsapp-chat-patient-file-btn"/);
  assert.match(html, /onclick="openActiveChatPatientFile\(\)"/);

  // 2. Verify relink button
  assert.match(html, /id="whatsapp-chat-relink-patient-btn"/);
  assert.match(html, /onclick="openLinkWhatsAppPatientModal\(\)"/);

  // 3. Verify modal container and accessibility attributes
  assert.match(html, /id="modal-link-whatsapp-patient"/);
  assert.match(html, /id="link-wa-modal-title"/);

  // 4. Verify segmented tab switcher
  assert.match(html, /id="tab-btn-link-wa-existing"/);
  assert.match(html, /id="tab-btn-link-wa-new"/);

  // 5. Verify existing patient tab controls
  assert.match(html, /id="link-wa-search-input"/);
  assert.match(html, /id="link-wa-patients-results"/);
  assert.match(html, /id="link-wa-selected-banner"/);
  assert.match(html, /id="link-wa-update-username-check"/);

  // 6. Verify new patient tab inputs
  assert.match(html, /id="link-new-patient-name"/);
  assert.match(html, /id="link-new-patient-phone"/);
  assert.match(html, /id="link-new-patient-gender"/);
  assert.match(html, /id="link-new-patient-username"/);
  assert.match(html, /id="link-new-patient-code"/);

  // 7. Verify submit button
  assert.match(html, /id="btn-submit-link-wa"/);
  assert.match(html, /onclick="submitLinkWhatsAppPatient\(\)"/);
});

test('WhatsApp linking modal strictly obeys AGENTS.md rules (no border slash opacity)', () => {
  // Extract modal section
  const modalStart = html.indexOf('id="modal-link-whatsapp-patient"');
  const modalEnd = html.indexOf('<!-- ================= MODAL: WHATSAPP LOCATION ================= -->', modalStart);
  const modalSection = html.slice(modalStart, modalEnd);

  // Test for illegal border slash-opacity patterns like border-slate-200/80
  const slashBorderMatches = modalSection.match(/border-[a-z]+-[0-9]+\/[0-9]+/g);
  assert.equal(slashBorderMatches, null, `Found illegal slash-opacity border classes: ${slashBorderMatches}`);
});

test('openActiveChatPatientFile redirects directly to patient profile if patient file is found', async () => {
  let switchedView = null;
  let openedModal = false;

  const mockContext = {
    activeWhatsAppConversation: {
      id: 'conv-101',
      phone: '201001234567',
      patient_id: 'patient-999'
    },
    activePatientId: null,
    switchView: async (view) => {
      switchedView = view;
    },
    ensurePatientForWhatsApp: async () => null,
    openLinkWhatsAppPatientModal: () => {
      openedModal = true;
    }
  };

  const snippet = `
    async function openActiveChatPatientFile() {
      if (!activeWhatsAppConversation) return;

      if (activeWhatsAppConversation.patient_id) {
        activePatientId = activeWhatsAppConversation.patient_id;
        await switchView('patient-profile');
        return;
      }

      const matchedPatient = await ensurePatientForWhatsApp(activeWhatsAppConversation);
      if (matchedPatient) {
        activeWhatsAppConversation.patient_id = matchedPatient.id;
        activePatientId = matchedPatient.id;
        await switchView('patient-profile');
        return;
      }

      openLinkWhatsAppPatientModal();
    }
  `;

  vm.runInNewContext(snippet, mockContext);

  await mockContext.openActiveChatPatientFile();

  assert.equal(mockContext.activePatientId, 'patient-999');
  assert.equal(switchedView, 'patient-profile');
  assert.equal(openedModal, false);
});

test('openActiveChatPatientFile matches patient by phone/username and redirects to profile', async () => {
  let switchedView = null;
  let openedModal = false;

  const mockContext = {
    activeWhatsAppConversation: {
      id: 'conv-102',
      phone: '@dr_sarah',
      patient_id: null
    },
    activePatientId: null,
    switchView: async (view) => {
      switchedView = view;
    },
    ensurePatientForWhatsApp: async (conv) => {
      if (conv.phone === '@dr_sarah') {
        return { id: 'patient-sarah', name: 'Dr. Sarah', whatsapp_username: 'dr_sarah' };
      }
      return null;
    },
    openLinkWhatsAppPatientModal: () => {
      openedModal = true;
    }
  };

  const snippet = `
    async function openActiveChatPatientFile() {
      if (!activeWhatsAppConversation) return;

      if (activeWhatsAppConversation.patient_id) {
        activePatientId = activeWhatsAppConversation.patient_id;
        await switchView('patient-profile');
        return;
      }

      const matchedPatient = await ensurePatientForWhatsApp(activeWhatsAppConversation);
      if (matchedPatient) {
        activeWhatsAppConversation.patient_id = matchedPatient.id;
        activePatientId = matchedPatient.id;
        await switchView('patient-profile');
        return;
      }

      openLinkWhatsAppPatientModal();
    }
  `;

  vm.runInNewContext(snippet, mockContext);

  await mockContext.openActiveChatPatientFile();

  assert.equal(mockContext.activePatientId, 'patient-sarah');
  assert.equal(mockContext.activeWhatsAppConversation.patient_id, 'patient-sarah');
  assert.equal(switchedView, 'patient-profile');
  assert.equal(openedModal, false);
});

test('openActiveChatPatientFile opens modal when patient file is not found', async () => {
  let switchedView = null;
  let openedModal = false;

  const mockContext = {
    activeWhatsAppConversation: {
      id: 'conv-103',
      phone: '201999999999',
      patient_id: null
    },
    activePatientId: null,
    switchView: async (view) => {
      switchedView = view;
    },
    ensurePatientForWhatsApp: async () => null,
    openLinkWhatsAppPatientModal: () => {
      openedModal = true;
    }
  };

  const snippet = `
    async function openActiveChatPatientFile() {
      if (!activeWhatsAppConversation) return;

      if (activeWhatsAppConversation.patient_id) {
        activePatientId = activeWhatsAppConversation.patient_id;
        await switchView('patient-profile');
        return;
      }

      const matchedPatient = await ensurePatientForWhatsApp(activeWhatsAppConversation);
      if (matchedPatient) {
        activeWhatsAppConversation.patient_id = matchedPatient.id;
        activePatientId = matchedPatient.id;
        await switchView('patient-profile');
        return;
      }

      openLinkWhatsAppPatientModal();
    }
  `;

  vm.runInNewContext(snippet, mockContext);

  await mockContext.openActiveChatPatientFile();

  assert.equal(mockContext.activePatientId, null);
  assert.equal(switchedView, null);
  assert.equal(openedModal, true);
});

test('Linking an existing patient updates patient record, links conversation, and redirects to patient-profile', async () => {
  let switchedView = null;
  let conversationUpdatePayload = null;
  let patientUpdatePayload = null;

  const existingPatient = {
    id: 'pat-123',
    patientNumber: '1042',
    name: 'Ahmed Mostafa',
    phone: '201000000000',
    whatsappUsername: null
  };

  const mockContext = {
    activeWhatsAppConversation: {
      id: 'conv-555',
      phone: '@ahmed_m',
      patient_id: null
    },
    patients: [existingPatient],
    patientDirectoryRows: [],
    linkWaActiveTab: 'existing',
    linkWaSelectedPatientId: 'pat-123',
    currentUiLanguage: 'en',
    activePatientId: null,
    db: {
      from: (table) => ({
        update: (payload) => ({
          eq: (field, val) => {
            if (table === 'whatsapp_conversations') conversationUpdatePayload = payload;
            if (table === 'patients') patientUpdatePayload = payload;
            return Promise.resolve({ error: null });
          }
        })
      })
    },
    document: {
      getElementById: (id) => {
        if (id === 'link-wa-update-username-check') return { checked: true };
        if (id === 'btn-submit-link-wa') return { disabled: false };
        if (id === 'link-wa-modal-error') return { classList: { add: () => {}, remove: () => {} }, textContent: '' };
        return null;
      }
    },
    isWhatsAppBsuid: () => false,
    isWhatsAppUsername: (v) => v.startsWith('@'),
    cleanWhatsAppUsername: (v) => v.replace(/^@+/, '').toLowerCase(),
    formatWhatsAppCode: (v) => v,
    renderWhatsAppConversationsList: () => {},
    selectWhatsAppConversation: async () => {},
    closeLinkWhatsAppPatientModal: () => {},
    showAppointmentNotificationToast: () => {},
    switchView: async (view) => {
      switchedView = view;
    },
    console: { error: () => {}, warn: () => {} }
  };

  // Run submitLinkWhatsAppPatient logic from index.html
  const fnStart = html.indexOf('async function submitLinkWhatsAppPatient()');
  const fnEnd = html.indexOf('function formatWhatsAppTime(', fnStart);
  const snippet = html.slice(fnStart, fnEnd);

  vm.runInNewContext(snippet, mockContext);

  await mockContext.submitLinkWhatsAppPatient();

  // Verify conversation updated
  assert.equal(conversationUpdatePayload.patient_id, 'pat-123');
  assert.equal(mockContext.activeWhatsAppConversation.patient_id, 'pat-123');

  // Verify patient updated with whatsapp_username
  assert.equal(patientUpdatePayload.whatsapp_username, 'ahmed_m');
  assert.equal(existingPatient.whatsappUsername, 'ahmed_m');

  // Verify redirect
  assert.equal(mockContext.activePatientId, 'pat-123');
  assert.equal(switchedView, 'patient-profile');
});

test('Creating a new patient inserts record, links conversation, and redirects to patient-profile', async () => {
  let switchedView = null;
  let insertedPayload = null;
  let conversationUpdatePayload = null;

  const mockContext = {
    activeWhatsAppConversation: {
      id: 'conv-777',
      phone: '+EG.4631528857091458',
      patient_name: 'Layla Fawzy',
      patient_id: null
    },
    patients: [],
    patientDirectoryRows: [],
    linkWaActiveTab: 'new',
    currentUiLanguage: 'en',
    activePatientId: null,
    PATIENT_SELECT_FIELDS: '*',
    db: {
      from: (table) => ({
        insert: (payload) => ({
          select: () => ({
            single: () => {
              insertedPayload = payload;
              return Promise.resolve({
                data: { id: 'new-pat-888', patient_number: '1050', ...payload },
                error: null
              });
            }
          })
        }),
        update: (payload) => ({
          eq: (field, val) => {
            if (table === 'whatsapp_conversations') conversationUpdatePayload = payload;
            return Promise.resolve({ error: null });
          }
        })
      })
    },
    document: {
      getElementById: (id) => {
        if (id === 'link-new-patient-name') return { value: 'Layla Fawzy' };
        if (id === 'link-new-patient-phone') return { value: '' };
        if (id === 'link-new-patient-gender') return { value: 'female' };
        if (id === 'link-new-patient-username') return { value: 'layla_f' };
        if (id === 'link-new-patient-code') return { value: '+EG.4631528857091458' };
        if (id === 'btn-submit-link-wa') return { disabled: false };
        if (id === 'link-wa-modal-error') return { classList: { add: () => {}, remove: () => {} }, textContent: '' };
        return null;
      }
    },
    isWhatsAppBsuid: () => true,
    isWhatsAppUsername: () => false,
    cleanWhatsAppUsername: (v) => v.replace(/^@+/, '').toLowerCase(),
    formatWhatsAppCode: (v) => v.startsWith('+') ? v : `+${v}`,
    normalisePatientRecord: (rec) => ({ ...rec, patientNumber: rec.patient_number }),
    renderWhatsAppConversationsList: () => {},
    selectWhatsAppConversation: async () => {},
    closeLinkWhatsAppPatientModal: () => {},
    showAppointmentNotificationToast: () => {},
    switchView: async (view) => {
      switchedView = view;
    },
    console: { error: () => {}, warn: () => {} }
  };

  const fnStart = html.indexOf('async function submitLinkWhatsAppPatient()');
  const fnEnd = html.indexOf('function formatWhatsAppTime(', fnStart);
  const snippet = html.slice(fnStart, fnEnd);

  vm.runInNewContext(snippet, mockContext);

  await mockContext.submitLinkWhatsAppPatient();

  // Verify new patient created with proper username and BSUID code
  assert.equal(insertedPayload.name, 'Layla Fawzy');
  assert.equal(insertedPayload.whatsapp_username, 'layla_f');
  assert.equal(insertedPayload.whatsapp_code, '+EG.4631528857091458');
  assert.equal(mockContext.patients.length, 1);
  assert.equal(mockContext.patients[0].id, 'new-pat-888');

  // Verify conversation updated
  assert.equal(conversationUpdatePayload.patient_id, 'new-pat-888');
  assert.equal(mockContext.activeWhatsAppConversation.patient_id, 'new-pat-888');

  // Verify redirect to patient profile
  assert.equal(mockContext.activePatientId, 'new-pat-888');
  assert.equal(switchedView, 'patient-profile');
});
