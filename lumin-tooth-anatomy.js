// Shared clinical tooth anatomy; editing and treatment state stay in their callers.
(function(root) {
  const SLOT_BY_PRIMARY_TOOTH = {A:4,B:5,C:6,D:7,E:8,F:9,G:10,H:11,I:12,J:13,K:20,L:21,M:22,N:23,O:24,P:25,Q:26,R:27,S:28,T:29};
  const isPrimaryToothId = id => /^[A-T]$/.test(String(id).toUpperCase());
    function getAnatomyType(toothId, slotNumber) {
      const id = String(toothId || '').toUpperCase();
      const slot = Number(slotNumber || SLOT_BY_PRIMARY_TOOTH[id] || id);
      const isUpper = slot >= 1 && slot <= 16;
      if (isPrimaryToothId(id)) {
        if (['A', 'B', 'I', 'J', 'K', 'L', 'S', 'T'].includes(id)) return isUpper ? 'primary-upper-molar' : 'primary-lower-molar';
        if (['C', 'H', 'M', 'R'].includes(id)) return isUpper ? 'primary-upper-canine' : 'primary-lower-canine';
        return isUpper ? 'primary-upper-incisor' : 'primary-lower-incisor';
      }
      if ([1, 2, 3, 14, 15, 16].includes(slot)) return 'upper-molar';
      if ([17, 18, 19, 30, 31, 32].includes(slot)) return 'lower-molar';
      if ([4, 5, 12, 13].includes(slot)) return 'upper-premolar';
      if ([20, 21, 28, 29].includes(slot)) return 'lower-premolar';
      if ([6, 11].includes(slot)) return 'upper-canine';
      if ([22, 27].includes(slot)) return 'lower-canine';
      return isUpper ? 'upper-incisor' : 'lower-incisor';
    }
    function generateRealisticToothSVG(toothId, slotNumber, showRootsAnatomy = true) {
      const id = String(toothId);
      const slot = Number(slotNumber || SLOT_BY_PRIMARY_TOOTH[id] || id);
      const type = getAnatomyType(id, slot);
      const isUpper = slot >= 1 && slot <= 16;
      const isPrimary = isPrimaryToothId(id);
      const isThirdMolar = [1, 16, 17, 32].includes(slot);
      const isUpperFirstPremolar = [5, 12].includes(slot);
      const isCentralIncisor = [8, 9, 24, 25].includes(slot);
      const isPatientRight = slot <= 8 || slot >= 25;
      const mirrorTransform = isPatientRight ? 'translate(64 0) scale(-1 1)' : '';
      const crownStroke = isPrimary ? '#a5a0d8' : '#d0ad73';
      const rootStroke = '#d0ad73';
      let rootPath = '';
      let crownPath = '';
      let rootDetails = '';
      let crownDetails = '';
      let rctLines = '';

      if (type === 'upper-molar') {
        rootPath = isThirdMolar
          ? 'M16 58 C13 44 13 22 18 8 C20 2 25 3 27 10 C29 18 30 30 31 42 C33 28 35 12 39 7 C42 3 47 5 48 11 C50 28 46 46 47 58 Z'
          : 'M13 58 C11 45 8 24 10 9 C11 3 15 2 18 7 C21 21 21 43 24 58 Z M25 58 C26 42 27 16 30 4 C31 0 35 0 36 5 C39 20 37 44 39 58 Z M40 58 C43 43 44 22 48 9 C50 3 54 4 55 10 C56 27 52 48 49 58 Z';
        crownPath = 'M10 55 C7 61 8 76 12 84 C17 91 46 91 52 85 C56 78 57 62 54 55 C49 57 45 53 39 56 C34 59 29 53 23 56 C18 59 15 55 10 55 Z';
        rootDetails = isThirdMolar
          ? '<path d="M24 11 C25 27 26 43 27 55 M41 10 C39 27 40 43 42 55" fill="none" stroke="#8f642f" stroke-width="0.8" opacity="0.45" />'
          : '<path d="M15 9 C16 25 18 43 20 55 M33 5 C33 22 33 41 33 56 M52 10 C50 27 48 44 46 55" fill="none" stroke="#8f642f" stroke-width="0.8" opacity="0.48" />';
        crownDetails = '<path d="M13 63 C19 58 25 63 31 60 C37 57 43 62 51 62 M16 72 C22 68 26 75 32 70 C38 66 43 73 49 69 M22 58 C23 69 21 80 25 87 M40 58 C39 69 42 80 38 87" fill="none" stroke="#9aa8b5" stroke-width="0.85" opacity="0.62" />';
        rctLines = isThirdMolar
          ? '<path d="M22 8 C24 24 25 42 26 62 M43 9 C40 25 40 43 40 62" fill="none" stroke="url(#guttaPerchaGrad)" stroke-width="1.7" stroke-linecap="round" />'
          : '<path d="M15 8 C16 26 19 45 21 62 M33 4 L33 62 M52 9 C49 28 47 46 44 62" fill="none" stroke="url(#guttaPerchaGrad)" stroke-width="1.65" stroke-linecap="round" />';
      } else if (type === 'lower-molar') {
        crownPath = 'M10 37 C7 31 8 16 12 8 C17 1 46 1 52 7 C56 14 57 30 54 37 C49 35 45 39 39 36 C34 33 29 39 23 36 C18 33 15 37 10 37 Z';
        rootPath = isThirdMolar
          ? 'M16 35 C14 49 13 70 18 84 C20 90 25 89 28 82 C31 73 31 60 32 50 C34 62 35 77 39 85 C42 91 47 88 48 82 C50 64 47 47 47 35 Z'
          : 'M14 35 C12 50 10 72 13 85 C14 91 19 92 22 86 C26 72 25 51 27 35 Z M37 35 C40 50 39 73 43 86 C46 92 51 90 52 84 C54 68 51 48 50 35 Z';
        rootDetails = isThirdMolar
          ? '<path d="M23 39 C22 56 23 72 24 84 M42 39 C43 56 44 72 44 84" fill="none" stroke="#8f642f" stroke-width="0.8" opacity="0.45" />'
          : '<path d="M19 39 C18 55 17 72 17 85 M45 39 C46 55 47 72 48 85" fill="none" stroke="#8f642f" stroke-width="0.8" opacity="0.48" />';
        crownDetails = '<path d="M13 29 C19 34 25 29 31 32 C37 35 43 28 51 30 M16 20 C22 24 26 17 32 22 C38 26 43 19 49 23 M22 34 C23 23 21 12 25 5 M40 34 C39 23 42 12 38 5" fill="none" stroke="#9aa8b5" stroke-width="0.85" opacity="0.62" />';
        rctLines = isThirdMolar
          ? '<path d="M23 29 C23 48 24 68 24 85 M41 29 C41 49 43 69 44 85" fill="none" stroke="url(#guttaPerchaGrad)" stroke-width="1.7" stroke-linecap="round" />'
          : '<path d="M20 29 C20 48 18 68 17 86 M45 29 C45 48 47 68 48 86" fill="none" stroke="url(#guttaPerchaGrad)" stroke-width="1.7" stroke-linecap="round" />';
      } else if (type === 'upper-premolar') {
        rootPath = isUpperFirstPremolar
          ? 'M21 58 C18 43 17 20 20 7 C21 2 25 1 27 6 C30 20 29 43 30 58 Z M33 58 C35 43 35 20 38 7 C40 2 44 3 45 8 C47 24 43 46 43 58 Z'
          : 'M23 58 C21 42 22 18 28 5 C30 1 35 1 37 6 C43 22 40 44 41 58 Z';
        crownPath = 'M15 56 C12 62 13 77 18 84 C22 89 27 86 32 91 C37 86 43 89 47 84 C52 76 52 62 49 56 C43 58 38 54 32 57 C26 54 21 58 15 56 Z';
        rootDetails = isUpperFirstPremolar
          ? '<path d="M24 8 C24 25 25 43 26 56 M41 8 C40 25 39 43 38 56" fill="none" stroke="#8f642f" stroke-width="0.8" opacity="0.46" />'
          : '<path d="M33 6 C31 25 32 43 33 56" fill="none" stroke="#8f642f" stroke-width="0.8" opacity="0.46" />';
        crownDetails = '<path d="M18 64 C24 60 28 64 32 61 C36 64 41 60 46 64 M22 72 C26 75 29 70 32 69 C36 70 39 75 43 72 M32 59 L32 87" fill="none" stroke="#9aa8b5" stroke-width="0.85" opacity="0.6" />';
        rctLines = isUpperFirstPremolar
          ? '<path d="M24 7 C24 27 26 46 27 63 M42 8 C40 28 39 47 38 63" fill="none" stroke="url(#guttaPerchaGrad)" stroke-width="1.65" stroke-linecap="round" />'
          : '<path d="M33 5 C32 25 33 46 33 64" fill="none" stroke="url(#guttaPerchaGrad)" stroke-width="1.7" stroke-linecap="round" />';
      } else if (type === 'lower-premolar') {
        crownPath = 'M15 36 C12 30 13 15 18 8 C22 3 27 6 32 1 C37 6 43 3 47 8 C52 16 52 30 49 36 C43 34 38 38 32 35 C26 38 21 34 15 36 Z';
        rootPath = 'M23 34 C21 50 22 74 27 87 C29 92 35 92 38 87 C43 71 40 50 41 34 Z';
        rootDetails = '<path d="M32 38 C31 54 32 72 33 87" fill="none" stroke="#8f642f" stroke-width="0.8" opacity="0.46" />';
        crownDetails = '<path d="M18 28 C24 32 28 28 32 31 C36 28 41 32 46 28 M22 20 C26 17 29 22 32 23 C36 22 39 17 43 20 M32 33 L32 5" fill="none" stroke="#9aa8b5" stroke-width="0.85" opacity="0.6" />';
        rctLines = '<path d="M32 28 C32 48 33 69 33 87" fill="none" stroke="url(#guttaPerchaGrad)" stroke-width="1.7" stroke-linecap="round" />';
      } else if (type === 'primary-upper-molar') {
        rootPath = 'M11 59 C7 44 4 22 7 10 C9 5 13 6 16 11 C20 25 20 44 23 58 Z M25 58 C25 42 27 19 30 8 C32 3 35 4 37 9 C39 24 38 43 39 58 Z M41 58 C45 43 48 24 53 12 C56 7 59 9 59 15 C59 31 54 49 52 59 Z';
        crownPath = 'M9 56 C5 63 7 77 12 84 C18 90 46 90 52 84 C57 77 59 63 55 56 C49 59 44 53 38 57 C33 60 29 53 23 57 C17 60 14 55 9 56 Z';
        rootDetails = '<path d="M11 12 C13 29 16 45 19 56 M33 9 L33 56 M56 14 C52 30 50 46 47 57" fill="none" stroke="#8f642f" stroke-width="0.75" opacity="0.46" />';
        crownDetails = '<path d="M12 65 C20 59 25 66 32 61 C39 66 45 59 52 65 M17 75 C23 70 28 78 32 72 C37 78 43 70 48 75 M23 58 L25 86 M41 58 L39 86" fill="none" stroke="#8998a8" stroke-width="0.8" opacity="0.6" />';
        rctLines = '<path d="M11 11 C13 29 17 47 20 63 M33 8 L33 63 M56 13 C52 31 49 48 46 63" fill="none" stroke="url(#guttaPerchaGrad)" stroke-width="1.55" stroke-linecap="round" />';
      } else if (type === 'primary-lower-molar') {
        crownPath = 'M9 36 C5 29 7 15 12 8 C18 2 46 2 52 8 C57 15 59 29 55 36 C49 33 44 39 38 35 C33 32 29 39 23 35 C17 32 14 37 9 36 Z';
        rootPath = 'M11 34 C7 49 5 70 9 83 C11 89 15 88 19 83 C23 70 22 50 24 35 Z M40 35 C43 50 42 70 47 83 C50 89 55 88 57 82 C60 68 56 48 54 34 Z';
        rootDetails = '<path d="M15 38 C13 54 13 70 13 83 M49 38 C51 54 52 70 53 83" fill="none" stroke="#8f642f" stroke-width="0.75" opacity="0.46" />';
        crownDetails = '<path d="M12 27 C20 33 25 26 32 31 C39 26 45 33 52 27 M17 17 C23 22 28 14 32 20 C37 14 43 22 48 17 M23 34 L25 6 M41 34 L39 6" fill="none" stroke="#8998a8" stroke-width="0.8" opacity="0.6" />';
        rctLines = '<path d="M16 28 C15 47 14 66 13 84 M48 28 C49 47 51 67 53 84" fill="none" stroke="url(#guttaPerchaGrad)" stroke-width="1.55" stroke-linecap="round" />';
      } else {
        const canine = type.includes('canine');
        const incisor = type.includes('incisor');
        const narrow = incisor && !isCentralIncisor;
        const primaryNarrow = isPrimary ? 2 : 0;
        const left = (canine ? 17 : narrow ? 20 : 17) + primaryNarrow;
        const right = 64 - left;
        if (isUpper) {
          rootPath = `M${left + 5} 58 C${left + 3} 43 ${left + 5} 19 29 5 C31 1 34 1 36 5 C43 20 ${right - 3} 43 ${right - 5} 58 Z`;
          crownPath = canine
            ? `M${left} 56 C${left - 2} 66 ${left + 2} 80 25 84 L32 91 L39 84 C${right - 2} 80 ${right + 2} 66 ${right} 56 C41 59 37 54 32 57 C27 54 23 59 ${left} 56 Z`
            : `M${left} 56 C${left - 2} 65 ${left + 1} 81 ${left + 5} 87 Q32 91 ${right - 5} 87 C${right - 1} 81 ${right + 2} 65 ${right} 56 C41 59 37 54 32 57 C27 54 23 59 ${left} 56 Z`;
          rootDetails = '<path d="M32 7 C30 26 31 43 32 56" fill="none" stroke="#8f642f" stroke-width="0.8" opacity="0.46" />';
          crownDetails = canine
            ? '<path d="M21 65 C26 61 29 66 32 62 C36 66 39 61 44 65 M23 75 C28 72 30 79 32 85 C35 79 37 72 42 75" fill="none" stroke="#9aa8b5" stroke-width="0.85" opacity="0.58" />'
            : '<path d="M21 65 C27 61 29 66 32 62 C36 66 39 61 43 65 M23 73 L22 84 M32 70 L32 87 M41 73 L42 84" fill="none" stroke="#9aa8b5" stroke-width="0.8" opacity="0.52" />';
          rctLines = '<path d="M33 5 C32 25 32 46 32 66" fill="none" stroke="url(#guttaPerchaGrad)" stroke-width="1.7" stroke-linecap="round" />';
        } else {
          crownPath = canine
            ? `M${left} 36 C${left - 2} 26 ${left + 2} 12 25 8 L32 1 L39 8 C${right - 2} 12 ${right + 2} 26 ${right} 36 C41 33 37 38 32 35 C27 38 23 33 ${left} 36 Z`
            : `M${left} 36 C${left - 2} 27 ${left + 1} 11 ${left + 5} 5 Q32 1 ${right - 5} 5 C${right - 1} 11 ${right + 2} 27 ${right} 36 C41 33 37 38 32 35 C27 38 23 33 ${left} 36 Z`;
          rootPath = `M${left + 5} 34 C${left + 3} 49 ${left + 5} 73 29 87 C31 91 34 91 36 87 C43 72 ${right - 3} 49 ${right - 5} 34 Z`;
          rootDetails = '<path d="M32 38 C30 57 31 74 32 87" fill="none" stroke="#8f642f" stroke-width="0.8" opacity="0.46" />';
          crownDetails = canine
            ? '<path d="M21 27 C26 31 29 26 32 30 C36 26 39 31 44 27 M23 17 C28 20 30 13 32 7 C35 13 37 20 42 17" fill="none" stroke="#9aa8b5" stroke-width="0.85" opacity="0.58" />'
            : '<path d="M21 27 C27 31 29 26 32 30 C36 26 39 31 43 27 M23 19 L22 8 M32 22 L32 5 M41 19 L42 8" fill="none" stroke="#9aa8b5" stroke-width="0.8" opacity="0.52" />';
          rctLines = '<path d="M32 26 C32 47 32 68 33 87" fill="none" stroke="url(#guttaPerchaGrad)" stroke-width="1.7" stroke-linecap="round" />';
        }
      }

      const cervicalLine = isUpper
        ? '<path d="M13 57 C22 61 25 55 32 58 C39 55 43 61 51 57" fill="none" stroke="#a87536" stroke-width="1" opacity="0.55" />'
        : '<path d="M13 35 C22 31 25 37 32 34 C39 37 43 31 51 35" fill="none" stroke="#a87536" stroke-width="1" opacity="0.55" />';
      const crownHighlight = isUpper
        ? '<path d="M17 61 C14 69 16 80 21 84" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" opacity="0.72" />'
        : '<path d="M17 31 C14 23 16 12 21 8" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" opacity="0.72" />';
      const rootHighlight = isUpper
        ? '<path d="M22 54 C20 40 21 22 25 10" fill="none" stroke="#fff8e7" stroke-width="1.25" stroke-linecap="round" opacity="0.58" />'
        : '<path d="M22 38 C20 52 21 70 25 82" fill="none" stroke="#fff8e7" stroke-width="1.25" stroke-linecap="round" opacity="0.58" />';
      const rootSVG = `
        <g>
          <path id="root-body-${id}" d="${rootPath}" fill="#fff7e7" stroke="${rootStroke}" stroke-width="1.15" stroke-linejoin="round" />
          ${rootHighlight}${rootDetails}
        </g>`;
      const crownSVG = `
        <g>
          <path id="crown-body-${id}" d="${crownPath}" fill="#fffcf5" stroke="${crownStroke}" stroke-width="1.25" stroke-linejoin="round" />
          ${cervicalLine}${crownHighlight}${crownDetails}
        </g>`;

      return `
        <div id="anatomy-wrapper-${id}" class="anatomy-wrapper odontogram-anatomy relative select-none ${showRootsAnatomy ? '' : 'hidden'} pointer-events-none" style="width:${isPrimary ? '44px' : '48px'};height:78px;min-width:${isPrimary ? '44px' : '48px'}">
          <svg viewBox="0 0 64 92" class="clinical-tooth-svg overflow-visible" style="display:block;width:100%;height:100%;overflow:visible" aria-hidden="true">
            <g id="anatomy-group-${id}">
              <g transform="${mirrorTransform}">${rootSVG}${crownSVG}</g>
            </g>
            <g id="rct-layer-${id}" class="hidden">
              <g transform="${mirrorTransform}">${rctLines}</g>
            </g>
          </svg>
          <div id="anatomy-overlay-${id}" class="absolute inset-0 pointer-events-none flex items-center justify-center"></div>
        </div>
      `;
    }
    const TOOTH_PHOTO_ASSETS = Object.freeze({
      incisor: 'assets/teeth-3d/incisor.webp',
      canine: 'assets/teeth-3d/canine.webp',
      premolar: 'assets/teeth-3d/premolar.webp',
      molar: 'assets/teeth-3d/molar.webp'
    });

    function toothPhotoFamily(anatomyType) {
      if (anatomyType.includes('molar')) return anatomyType.includes('premolar') ? 'premolar' : 'molar';
      if (anatomyType.includes('canine')) return 'canine';
      return 'incisor';
    }

    function generateRealisticToothPhoto(toothId, slotNumber, showRootsAnatomy = true) {
      const id = String(toothId);
      const slot = Number(slotNumber || SLOT_BY_PRIMARY_TOOTH[id] || id);
      const anatomyType = getAnatomyType(id, slot);
      const family = toothPhotoFamily(anatomyType);
      const isUpper = slot >= 1 && slot <= 16;
      const isPrimary = isPrimaryToothId(id);
      const isPatientRight = slot <= 8 || slot >= 25;
      const photoClasses = [
        'tooth-photo',
        isUpper ? 'is-upper-photo' : '',
        isPatientRight ? 'is-mirrored-photo' : '',
        isPrimary ? 'is-primary-photo' : ''
      ].filter(Boolean).join(' ');
      const rootCanalCount = family === 'molar' ? 3 : family === 'premolar' ? 2 : 1;
      const rootCanalMarkup = Array.from({ length: rootCanalCount }, (_, index) => `<span class="rct-canal canal-${index + 1}"></span>`).join('');
      return `
        <div id="anatomy-wrapper-${id}" class="anatomy-wrapper odontogram-anatomy relative select-none ${showRootsAnatomy ? '' : 'hidden'} pointer-events-none" style="width:${isPrimary ? '44px' : '48px'};height:78px;min-width:${isPrimary ? '44px' : '48px'}">
          <div id="anatomy-group-${id}" class="absolute inset-0">
            <div class="tooth-photo-stage">
              <img id="tooth-photo-${id}" src="${TOOTH_PHOTO_ASSETS[family]}" alt="" aria-hidden="true" draggable="false" class="${photoClasses}" />
              <img id="tooth-crown-overlay-${id}" src="${TOOTH_PHOTO_ASSETS[family]}" alt="" aria-hidden="true" draggable="false" class="${photoClasses} tooth-crown-color-overlay" />
              <div id="rct-layer-${id}" class="hidden photo-rct-mask family-${family} ${isUpper ? 'is-upper' : 'is-lower'} ${isPrimary ? 'is-primary-rct' : ''}">
                <span class="rct-pulp-chamber"></span>${rootCanalMarkup}
              </div>
            </div>
          </div>
          <div id="anatomy-overlay-${id}" class="absolute inset-0 pointer-events-none flex items-center justify-center"></div>
        </div>`;
    }

  root.LuminToothAnatomy = {type:getAnatomyType, generate:generateRealisticToothSVG, photo:generateRealisticToothPhoto};
})(globalThis);
