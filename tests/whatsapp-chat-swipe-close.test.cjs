const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

test('WhatsApp mobile header back button triggers closeActiveWhatsAppChat()', () => {
  assert.match(
    html,
    /<button[^>]*onclick="closeActiveWhatsAppChat\(\)"[^>]*aria-label="Back to conversations"/,
    'Back button in chat header should call closeActiveWhatsAppChat()'
  );
});

test('closeActiveWhatsAppChat function is defined and coordinates mobile and desktop closing', () => {
  assert.match(
    html,
    /function closeActiveWhatsAppChat\(\)\s*\{[\s\S]*?closeActiveWhatsAppChatOnMobile\(\);[\s\S]*?clearWhatsAppReplyMessage\(\);[\s\S]*?activeWhatsAppConversationId\s*=\s*null;/,
    'closeActiveWhatsAppChat should close mobile view, clear reply message, and deselect conversation on desktop'
  );
});

test('closeActiveWhatsAppChatOnMobile blurs active element and resets chat transforms', () => {
  assert.match(
    html,
    /function closeActiveWhatsAppChatOnMobile\(\)\s*\{[\s\S]*?document\.activeElement\.blur\(\);[\s\S]*?document\.body\.classList\.remove\('whatsapp-mobile-chat-open'[\s\S]*?activeChatEl\.style\.transform\s*=\s*'';/,
    'closeActiveWhatsAppChatOnMobile should blur inputs, remove mobile open classes, and reset transform styles'
  );
});

test('selectWhatsAppConversation resets transform, transition, and opacity on active chat container', () => {
  assert.match(
    html,
    /const activeChatEl = document\.getElementById\('whatsapp-chat-active'\);[\s\S]*?activeChatEl\.style\.transform = '';[\s\S]*?activeChatEl\.style\.transition = '';[\s\S]*?activeChatEl\.style\.opacity = '';/,
    'selectWhatsAppConversation should reset any swipe animation styles when opening a chat'
  );
});

test('initWhatsAppChatSwipeToClose is defined and initialized on DOMContentLoaded and renderWhatsAppView', () => {
  assert.match(html, /function initWhatsAppChatSwipeToClose\(\)\s*\{/);
  assert.match(html, /setupWhatsAppMobileViewport\(\);\s*initWhatsAppChatSwipeToClose\(\);/);
  assert.match(html, /renderWhatsAppConversationsList\(\);\s*initWhatsAppChatSwipeToClose\(\);/);
});

test('initWhatsAppChatSwipeToClose excludes reply composer panel and interactive controls', () => {
  assert.match(
    html,
    /target\.closest\('#whatsapp-reply-panel'\)/,
    'Touches starting inside reply composer panel should be excluded from closing the chat'
  );
  assert.match(
    html,
    /target\.closest\('button, a, input, textarea, select, audio, \[role="button"\], \[data-interactive\]'\)/,
    'Touches starting on interactive controls should not trigger swipe-to-close'
  );
});

test('initWhatsAppChatSwipeToClose supports both left and right swipes to close chat', () => {
  assert.match(
    html,
    /const isSwipeClose = \(distanceX >= 55\) \|\| \(distanceX >= 35 && velocity >= 0\.28\);/,
    'Swipe to close threshold should support standard distance and fast velocity flicks'
  );
  assert.match(
    html,
    /const exitDirection = deltaX > 0 \? '100%' : '-100%';/,
    'Swipe animation should slide off in the swipe direction (both right deltaX > 0 and left deltaX < 0)'
  );
  assert.match(
    html,
    /activeChatEl\.style\.transform = `translateX\(\$\{exitDirection\}\)`;[\s\S]*?closeActiveWhatsAppChat\(\);/,
    'Exit animation should slide active chat and call closeActiveWhatsAppChat()'
  );
});

test('message bubble swipe yields when horizontal chat swipe-to-close is active', () => {
  assert.match(
    html,
    /if \(waChatSwipeGesture && waChatSwipeGesture\.axis === 'horizontal'\) \{[\s\S]*?waSwipedRow = null;[\s\S]*?waIsSwiping = false;\s*return;\s*\}/,
    'Message row swipe should yield and not quote messages when horizontal chat swipe-to-close is active'
  );
});

test('simulated swipe-to-close gesture logic accurately resolves swipe directions and vertical locks', () => {
  function simulateGesture({ startX, startY, moves, duration, targetIsInput = false, targetInReply = false }) {
    let closed = false;
    let axis = null;
    let activeChatTransform = '';
    let activeChatOpacity = '';

    const isEligibleTarget = !targetIsInput && !targetInReply;
    if (!isEligibleTarget) return { closed: false, axis: null };

    let currentX = startX;
    let currentY = startY;

    for (const move of moves) {
      currentX = move.x;
      currentY = move.y;
      const deltaX = currentX - startX;
      const deltaY = currentY - startY;
      const distanceX = Math.abs(deltaX);
      const distanceY = Math.abs(deltaY);

      if (!axis && Math.max(distanceX, distanceY) >= 10) {
        if (distanceX <= distanceY * 1.3) {
          axis = 'vertical';
        } else {
          axis = 'horizontal';
        }
      }

      if (axis === 'horizontal') {
        activeChatTransform = `translateX(${deltaX * 0.75}px)`;
        activeChatOpacity = String(Math.max(0.35, 1 - distanceX / 450));
      }
    }

    if (axis === 'horizontal') {
      const deltaX = currentX - startX;
      const deltaY = currentY - startY;
      const distanceX = Math.abs(deltaX);
      const distanceY = Math.abs(deltaY);
      const velocity = distanceX / Math.max(1, duration);

      const isSwipeClose = (distanceX >= 55) || (distanceX >= 35 && velocity >= 0.28);
      const isDominant = distanceX > distanceY * 1.25;

      if (isSwipeClose && isDominant) {
        closed = true;
      }
    }

    return { closed, axis, activeChatTransform, activeChatOpacity };
  }

  // 1. Right swipe (close chat)
  const rightSwipe = simulateGesture({
    startX: 100,
    startY: 200,
    moves: [{ x: 120, y: 202 }, { x: 150, y: 203 }, { x: 180, y: 205 }], // deltaX = +80
    duration: 180
  });
  assert.equal(rightSwipe.axis, 'horizontal');
  assert.equal(rightSwipe.closed, true, 'Right swipe with deltaX=80 should close the chat');

  // 2. Left swipe (close chat)
  const leftSwipe = simulateGesture({
    startX: 250,
    startY: 200,
    moves: [{ x: 230, y: 201 }, { x: 200, y: 203 }, { x: 170, y: 204 }], // deltaX = -80
    duration: 180
  });
  assert.equal(leftSwipe.axis, 'horizontal');
  assert.equal(leftSwipe.closed, true, 'Left swipe with deltaX=-80 should close the chat');

  // 3. Vertical message scroll (should NOT close chat)
  const verticalScroll = simulateGesture({
    startX: 150,
    startY: 200,
    moves: [{ x: 152, y: 230 }, { x: 153, y: 280 }, { x: 154, y: 340 }], // deltaY = +140, deltaX = 4
    duration: 250
  });
  assert.equal(verticalScroll.axis, 'vertical');
  assert.equal(verticalScroll.closed, false, 'Vertical scroll should not close chat');

  // 4. Touch starting in reply panel (should NOT close chat)
  const replyPanelTouch = simulateGesture({
    startX: 100,
    startY: 550,
    moves: [{ x: 180, y: 550 }],
    duration: 150,
    targetInReply: true
  });
  assert.equal(replyPanelTouch.closed, false, 'Reply panel touches must not close chat');

  // 5. Short drag below threshold (springs back, does NOT close)
  const shortDrag = simulateGesture({
    startX: 100,
    startY: 200,
    moves: [{ x: 115, y: 201 }, { x: 125, y: 202 }], // deltaX = 25
    duration: 400 // slow, low velocity
  });
  assert.equal(shortDrag.axis, 'horizontal');
  assert.equal(shortDrag.closed, false, 'Short drag below threshold should not close chat');

  // 6. Fast flick above flick threshold (deltaX = 40 in 80ms => velocity = 0.5 px/ms)
  const fastFlick = simulateGesture({
    startX: 100,
    startY: 200,
    moves: [{ x: 140, y: 202 }], // deltaX = 40
    duration: 80
  });
  assert.equal(fastFlick.axis, 'horizontal');
  assert.equal(fastFlick.closed, true, 'Fast flick with distance 40 and high velocity should close chat');
});
