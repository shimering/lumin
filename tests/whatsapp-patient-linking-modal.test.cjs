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
  const modalStart = html.indexOf('id="modal-link-whatsapp-patient"');
  const modalEnd = html.indexOf('<!-- ================= MODAL: WHATSAPP LOCATION ================= -->', modalStart);
  const modalSection = html.slice(modalStart, modalEnd);

  const slashBorderMatches = modalSection.match(/border-[a-z]+-[0-9]+\/[0-9]+/g);
  assert.equal(slashBorderMatches, null, `Found illegal slash-opacity border classes: ${slashBorderMatches}`);
});

test('openActiveChatPatientFile sets activeWorkspacePatientId and calls openPatientWorkspace', async () => {
  let openedWorkspacePatientId = null;
  let openedWorkspaceTab = null;
  let openedWorkspaceReturnView = null;
  let openedModal = false;

  const mockContext = {
    activeWhatsAppConversation: {
      id: 'conv-101',
      phone: '201001234567',
      patient_id: 'patient-999'
    },
    activeWorkspacePatientId: 'wrong-patient-roaa',
    activePatientId: null,
    openPatientWorkspace: async (patientId, tab, returnView) => {
      openedWorkspacePatientId = patientId;
      openedWorkspaceTab = tab;
      openedWorkspaceReturnView = returnView;
    },
    ensurePatientForWhatsApp: async () => null,
    openLinkWhatsAppPatientModal: () => {
      openedModal = true;
    }
  };

  const fnStart = html.indexOf('async function openActiveChatPatientFile()');
  const fnEnd = html.indexOf('let linkWaActiveTab =', fnStart);
  const snippet = html.slice(fnStart, fnEnd);

  vm.runInNewContext(snippet, mockContext);

  await mockContext.openActiveChatPatientFile();

  // MUST set both activePatientId and activeWorkspacePatientId to the actual linked patient!
  assert.equal(mockContext.activePatientId, 'patient-999');
  assert.equal(mockContext.activeWorkspacePatientId, 'patient-999');
  assert.equal(openedWorkspacePatientId, 'patient-999');
  assert.equal(openedWorkspaceTab, 'profile');
  assert.equal(openedWorkspaceReturnView, 'whatsapp');
  assert.equal(openedModal, false);
});

test('openActiveChatPatientFile matches patient by phone/username, sets workspace and redirects', async () => {
  let openedWorkspacePatientId = null;
  let openedModal = false;

  const mockContext = {
    activeWhatsAppConversation: {
      id: 'conv-102',
      phone: '@dr_sarah',
      patient_id: null
    },
    activeWorkspacePatientId: 'wrong-patient-roaa',
    activePatientId: null,
    openPatientWorkspace: async (patientId, tab, returnView) => {
      openedWorkspacePatientId = patientId;
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

  const fnStart = html.indexOf('async function openActiveChatPatientFile()');
  const fnEnd = html.indexOf('let linkWaActiveTab =', fnStart);
  const snippet = html.slice(fnStart, fnEnd);

  vm.runInNewContext(snippet, mockContext);

  await mockContext.openActiveChatPatientFile();

  assert.equal(mockContext.activePatientId, 'patient-sarah');
  assert.equal(mockContext.activeWorkspacePatientId, 'patient-sarah');
  assert.equal(mockContext.activeWhatsAppConversation.patient_id, 'patient-sarah');
  assert.equal(openedWorkspacePatientId, 'patient-sarah');
  assert.equal(openedModal, false);
});

test('openActiveChatPatientFile opens modal when patient file is not found', async () => {
  let openedWorkspacePatientId = null;
  let openedModal = false;

  const mockContext = {
    activeWhatsAppConversation: {
      id: 'conv-103',
      phone: '201999999999',
      patient_id: null
    },
    activeWorkspacePatientId: 'prev-patient',
    activePatientId: null,
    openPatientWorkspace: async (patientId) => {
      openedWorkspacePatientId = patientId;
    },
    ensurePatientForWhatsApp: async () => null,
    openLinkWhatsAppPatientModal: () => {
      openedModal = true;
    }
  };

  const fnStart = html.indexOf('async function openActiveChatPatientFile()');
  const fnEnd = html.indexOf('let linkWaActiveTab =', fnStart);
  const snippet = html.slice(fnStart, fnEnd);

  vm.runInNewContext(snippet, mockContext);

  await mockContext.openActiveChatPatientFile();

  assert.equal(mockContext.activePatientId, null);
  assert.equal(openedWorkspacePatientId, null);
  assert.equal(openedModal, true);
});

test('Linking an existing patient updates patient record, links conversation, sets activeWorkspacePatientId and redirects to patient-profile', async () => {
  let openedWorkspacePatientId = null;
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
    activeWorkspacePatientId: 'wrong-patient-roaa',
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
    openPatientWorkspace: async (patientId, tab, returnView) => {
      openedWorkspacePatientId = patientId;
    },
    console: { error: () => {}, warn: () => {} }
  };

  const fnStart = html.indexOf('async function submitLinkWhatsAppPatient()');
  const fnEnd = html.indexOf('function formatWhatsAppTime(', fnStart);
  const snippet = html.slice(fnStart, fnEnd);

  vm.runInNewContext(snippet, mockContext);

  await mockContext.submitLinkWhatsAppPatient();

  // Verify conversation updated
  assert.equal(conversationUpdatePayload.patient_id, 'pat-123');
  assert.equal(mockContext.activeWhatsAppConversation.patient_id, 'pat-123');

  // Verify patient updated with whatsapp_username
  assert.equal(patientUpdatePayload.whatsapp_username, '@ahmed_m');
  assert.equal(existingPatient.whatsappUsername, '@ahmed_m');

  // Verify workspace patient ID is updated to the newly linked patient!
  assert.equal(mockContext.activeWorkspacePatientId, 'pat-123');
  assert.equal(mockContext.activePatientId, 'pat-123');
  assert.equal(openedWorkspacePatientId, 'pat-123');
});

test('Linking an existing patient with entered username saves username with @ even when conversation phone is BSUID', async () => {
  let openedWorkspacePatientId = null;
  let conversationUpdatePayload = null;
  let patientUpdatePayload = null;

  const existingPatient = {
    id: 'pat-999',
    patientNumber: '1088',
    name: 'Sara Connor',
    phone: '201011111111',
    whatsappUsername: null,
    whatsappCode: null
  };

  const mockContext = {
    activeWhatsAppConversation: {
      id: 'conv-bsuid-1',
      phone: '+EG.4631528857091458',
      patient_id: null
    },
    patients: [existingPatient],
    patientDirectoryRows: [],
    linkWaActiveTab: 'existing',
    linkWaSelectedPatientId: 'pat-999',
    currentUiLanguage: 'en',
    activeWorkspacePatientId: 'wrong-patient-roaa',
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
        if (id === 'link-existing-patient-username') return { value: 'sara_c' };
        if (id === 'link-existing-patient-code') return { value: '+EG.4631528857091458' };
        if (id === 'btn-submit-link-wa') return { disabled: false };
        if (id === 'link-wa-modal-error') return { classList: { add: () => {}, remove: () => {} }, textContent: '' };
        return null;
      }
    },
    isWhatsAppBsuid: (v) => v.includes('EG.'),
    isWhatsAppUsername: () => false,
    cleanWhatsAppUsername: (v) => v.replace(/^@+/, '').toLowerCase(),
    formatWhatsAppCode: (v) => v.startsWith('+') ? v : `+${v}`,
    renderWhatsAppConversationsList: () => {},
    selectWhatsAppConversation: async () => {},
    closeLinkWhatsAppPatientModal: () => {},
    showAppointmentNotificationToast: () => {},
    openPatientWorkspace: async (patientId, tab, returnView) => {
      openedWorkspacePatientId = patientId;
    },
    console: { error: () => {}, warn: () => {} }
  };

  const fnStart = html.indexOf('async function submitLinkWhatsAppPatient()');
  const fnEnd = html.indexOf('function formatWhatsAppTime(', fnStart);
  const snippet = html.slice(fnStart, fnEnd);

  vm.runInNewContext(snippet, mockContext);

  await mockContext.submitLinkWhatsAppPatient();

  // Verify conversation updated
  assert.equal(conversationUpdatePayload.patient_id, 'pat-999');
  assert.equal(mockContext.activeWhatsAppConversation.patient_id, 'pat-999');

  // Verify patient updated with both entered username (with @) and whatsapp_code
  assert.equal(patientUpdatePayload.whatsapp_username, '@sara_c');
  assert.equal(patientUpdatePayload.whatsapp_code, '+EG.4631528857091458');
  assert.equal(existingPatient.whatsappUsername, '@sara_c');
  assert.equal(existingPatient.whatsappCode, '+EG.4631528857091458');

  // Verify workspace redirect
  assert.equal(mockContext.activeWorkspacePatientId, 'pat-999');
  assert.equal(mockContext.activePatientId, 'pat-999');
  assert.equal(openedWorkspacePatientId, 'pat-999');
});

test('Creating a new patient inserts record, links conversation, sets activeWorkspacePatientId and redirects to patient-profile', async () => {
  let openedWorkspacePatientId = null;
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
    activeWorkspacePatientId: 'wrong-patient-roaa',
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
    openPatientWorkspace: async (patientId, tab, returnView) => {
      openedWorkspacePatientId = patientId;
    },
    console: { error: () => {}, warn: () => {} }
  };

  const fnStart = html.indexOf('async function submitLinkWhatsAppPatient()');
  const fnEnd = html.indexOf('function formatWhatsAppTime(', fnStart);
  const snippet = html.slice(fnStart, fnEnd);

  vm.runInNewContext(snippet, mockContext);

  await mockContext.submitLinkWhatsAppPatient();

  // Verify new patient created
  assert.equal(insertedPayload.name, 'Layla Fawzy');
  assert.equal(insertedPayload.whatsapp_username, '@layla_f');
  assert.equal(insertedPayload.whatsapp_code, '+EG.4631528857091458');
  assert.equal(mockContext.patients.length, 1);
  assert.equal(mockContext.patients[0].id, 'new-pat-888');

  // Verify conversation updated
  assert.equal(conversationUpdatePayload.patient_id, 'new-pat-888');
  assert.equal(mockContext.activeWhatsAppConversation.patient_id, 'new-pat-888');

  // Verify workspace patient ID is updated to the newly created patient!
  assert.equal(mockContext.activeWorkspacePatientId, 'new-pat-888');
  assert.equal(mockContext.activePatientId, 'new-pat-888');
  assert.equal(openedWorkspacePatientId, 'new-pat-888');
});

test('selectLinkWhatsAppPatient pre-fills existing username and code fields in confirmation banner', () => {
  const existingPatient = {
    id: 'pat-101',
    patientNumber: '1090',
    name: 'Karim Adel',
    whatsappUsername: '@karim_adel',
    whatsappCode: '+EG.4631528857091458'
  };

  const usernameField = { value: '' };
  const codeField = { value: '' };
  const bannerEl = { classList: { remove: () => {}, add: () => {} } };
  const summaryEl = { textContent: '' };
  const descEl = { textContent: '' };

  const mockContext = {
    linkWaSelectedPatientId: null,
    patients: [existingPatient],
    patientDirectoryRows: [],
    activeWhatsAppConversation: {
      phone: '+EG.4631528857091458'
    },
    currentUiLanguage: 'en',
    document: {
      getElementById: (id) => {
        if (id === 'link-wa-selected-banner') return bannerEl;
        if (id === 'link-wa-selected-summary') return summaryEl;
        if (id === 'link-wa-selected-desc') return descEl;
        if (id === 'link-existing-patient-username') return usernameField;
        if (id === 'link-existing-patient-code') return codeField;
        if (id === 'link-wa-search-input') return { value: '' };
        return null;
      }
    },
    isWhatsAppBsuid: (v) => v.includes('EG.'),
    isWhatsAppUsername: () => false,
    cleanWhatsAppUsername: (v) => v.replace(/^@+/, '').toLowerCase(),
    formatWhatsAppCode: (v) => v.startsWith('+') ? v : `+${v}`,
    filterLinkWhatsAppPatients: () => {}
  };

  const fnStart = html.indexOf('function selectLinkWhatsAppPatient(patientId)');
  const fnEnd = html.indexOf('function openLinkWhatsAppPatientModal()', fnStart);
  const snippet = html.slice(fnStart, fnEnd);

  vm.runInNewContext(snippet, mockContext);

  mockContext.selectLinkWhatsAppPatient('pat-101');

  assert.equal(mockContext.linkWaSelectedPatientId, 'pat-101');
  assert.equal(usernameField.value, 'karim_adel');
  assert.equal(codeField.value, '+EG.4631528857091458');
  assert.match(summaryEl.textContent, /Karim Adel/);
});

test('renderPatientProfile auto-resolves missing whatsappCode from linked conversation', async () => {
  let updatedDbPatch = null;
  let updatedPatientId = null;

  const patient = {
    id: '66',
    name: 'محمد لطفي',
    phone: '01000000000',
    whatsappCode: null,
    whatsappUsername: null
  };

  const elements = {};
  const getEl = (id) => {
    if (!elements[id]) elements[id] = { textContent: '', innerHTML: '', classList: { add: () => {}, remove: () => {}, toggle: () => {} } };
    return elements[id];
  };

  const mockContext = {
    patientWorkspaceId: () => '66',
    getKnownPatient: (id) => (id === '66' ? patient : null),
    ensureKnownPatient: async (id) => (id === '66' ? patient : null),
    switchView: () => {},
    activeWorkspacePatientId: null,
    updatePatientWorkspaceNavigation: () => {},
    patientPhoneActionsMarkup: () => '',
    patientAgeProfileLabel: () => '30y',
    formatPatientNumber: () => '#66',
    activeWhatsAppConversation: {
      patient_id: '66',
      phone: '+EG.1372864025001690'
    },
    whatsappConversations: [],
    currentSession: { user: { id: 'test' } },
    currentUiLanguage: 'ar',
    isWhatsAppBsuid: (v) => String(v).includes('EG.'),
    isWhatsAppUsername: () => false,
    formatWhatsAppCode: (v) => (v.startsWith('+') ? v : `+${v}`),
    cleanWhatsAppUsername: (v) => v.replace(/^@+/, ''),
    hasPageAccess: () => true,
    escapeHtml: (s) => s,
    db: {
      from: () => ({
        update: (patch) => ({
          eq: (col, val) => {
            updatedDbPatch = patch;
            updatedPatientId = val;
            return Promise.resolve({ error: null });
          }
        })
      })
    },
    document: {
      getElementById: getEl
    },
    // stubs for elements/functions called by renderPatientProfile
    getPatientNameInitials: () => 'ML',
    renderPatientProfileTreatments: () => {},
    renderPatientProfileInvoices: () => {},
    renderPatientProfileAppointments: () => {},
    renderPatientProfilePrescriptions: () => {},
    renderPatientProfileAttachments: () => {},
    renderPatientProfileToothChart: () => {},
    renderPatientProfileClinicalNotes: () => {},
    updatePatientMedicalHistoryBadges: () => {},
    translateUiTree: () => {},
    lucide: { createIcons: () => {} }
  };

  const fnStart = html.indexOf('async function renderPatientProfile()');
  const fnEnd = html.indexOf('function firstAuthorizedClinicManagementTab', fnStart);
  const snippet = html.slice(fnStart, fnEnd);

  vm.runInNewContext(snippet, mockContext);

  await mockContext.renderPatientProfile();

  assert.equal(patient.whatsappCode, '+EG.1372864025001690');
  assert.equal(elements['profile-patient-whatsapp-code'].textContent, '+EG.1372864025001690');
  assert.ok(updatedDbPatch);
  assert.equal(updatedDbPatch.whatsapp_code, '+EG.1372864025001690');
  assert.equal(updatedPatientId, '66');
});

