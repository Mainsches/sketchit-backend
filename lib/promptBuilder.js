export function normalizeText(value = '') {
  return String(value).trim();
}

const VALID_AI_MODES = new Set(['product', 'architect', 'mechanical', 'artist']);

export function normalizeMode(mode) {
  const key = normalizeText(mode).toLowerCase();
  if (VALID_AI_MODES.has(key)) return key;
  return 'product';
}

function textToNumber(value = '') {
  const text = String(value).toLowerCase().trim();

  const map = [
    { patterns: ['one', '1', 'single'], value: 1 },
    { patterns: ['two', '2', 'double'], value: 2 },
    { patterns: ['three', '3'], value: 3 },
    { patterns: ['four', '4'], value: 4 },
    { patterns: ['five', '5'], value: 5 },
    { patterns: ['six', '6'], value: 6 },
  ];

  for (const entry of map) {
    if (entry.patterns.includes(text)) {
      return entry.value;
    }
  }

  return null;
}

function findNumberBeforeKeyword(prompt = '', keywords = []) {
  const text = prompt.toLowerCase();
  const numberWords = '(one|two|three|four|five|six|1|2|3|4|5|6|single|double)';
  const keywordGroup = keywords.join('|');
  const regex = new RegExp(`${numberWords}\\s+(${keywordGroup})`, 'i');
  const match = text.match(regex);

  if (!match) return null;

  return textToNumber(match[1]);
}

function detectDoorCount(prompt = '') {
  return findNumberBeforeKeyword(prompt, ['door', 'doors']);
}

function detectDrawerCount(prompt = '') {
  return findNumberBeforeKeyword(prompt, ['drawer', 'drawers']);
}

function detectShelfCount(prompt = '') {
  return findNumberBeforeKeyword(prompt, ['shelf', 'shelves', 'compartment', 'compartments', 'section', 'sections']);
}

function detectMaterial(prompt = '') {
  const text = prompt.toLowerCase();

  if (
    text.includes('oak') ||
    text.includes('wood') ||
    text.includes('wooden') ||
    text.includes('walnut') ||
    text.includes('ash wood') ||
    text.includes('grey wood') ||
    text.includes('gray wood')
  ) {
    return 'wood';
  }

  if (
    text.includes('metal') ||
    text.includes('steel') ||
    text.includes('aluminium') ||
    text.includes('aluminum') ||
    text.includes('iron')
  ) {
    return 'metal';
  }

  if (text.includes('glass') || text.includes('glas')) {
    return 'glass';
  }

  if (
    text.includes('fabric') ||
    text.includes('textile') ||
    text.includes('upholstered') ||
    text.includes('cushion')
  ) {
    return 'fabric';
  }

  return 'neutral';
}

function detectColors(prompt = '') {
  const text = prompt.toLowerCase();
  const colors = [];
  const knownColors = ['white', 'black', 'grey', 'gray', 'brown', 'beige', 'oak', 'walnut', 'green', 'blue', 'red'];

  for (const color of knownColors) {
    if (text.includes(color)) {
      colors.push(color);
    }
  }

  return [...new Set(colors)];
}

function detectStyleHints(prompt = '') {
  const text = prompt.toLowerCase();
  const styles = [];

  if (text.includes('minimal')) styles.push('minimal');
  if (text.includes('modern')) styles.push('modern');
  if (text.includes('scandinavian')) styles.push('scandinavian');
  if (text.includes('industrial')) styles.push('industrial');
  if (text.includes('premium') || text.includes('luxury')) styles.push('premium');

  return styles;
}

function detectFurnitureType(prompt = '') {
  const text = prompt.toLowerCase();

  if (text.includes('chair')) return 'chair';
  if (text.includes('table')) return 'table';
  if (text.includes('cabinet')) return 'cabinet';
  if (text.includes('closet')) return 'closet';
  if (text.includes('wardrobe')) return 'wardrobe';
  if (text.includes('shelf')) return 'shelf';
  if (text.includes('sideboard')) return 'sideboard';
  if (text.includes('stool')) return 'stool';
  if (text.includes('bench')) return 'bench';
  if (text.includes('desk')) return 'desk';

  return 'general furniture object';
}

function buildColorInstruction(colors = []) {
  if (!colors.length) {
    return 'Choose neutral, believable product colors that read clearly on a studio backdrop.';
  }

  if (colors.includes('white') && (colors.includes('grey') || colors.includes('gray'))) {
    return 'Commit to a white and grey palette that matches the sketch segmentation and reads as premium product photography.';
  }

  if (colors.includes('brown') && (colors.includes('grey') || colors.includes('gray'))) {
    return 'Commit to grey and brown tones that lock to the sketch segmentation and material reads.';
  }

  return `Apply these named colors as locked accents tied to sketch segmentation: ${colors.join(', ')}.`;
}

function buildMaterialInstruction(material, prompt = '') {
  const text = prompt.toLowerCase();

  if (material === 'wood') {
    if (text.includes('grey wood') || text.includes('gray wood')) {
      return 'Use realistic grey wood as the main material and preserve a believable wood texture.';
    }
    if (text.includes('oak')) {
      return 'Use realistic oak wood as the main material with believable grain and a premium furniture finish.';
    }
    if (text.includes('walnut')) {
      return 'Use realistic walnut wood as the main material with rich natural grain and a premium finish.';
    }
    return 'Use realistic wood as the main material with believable grain, clean edges, and a manufacturable finish.';
  }

  if (material === 'metal') {
    return 'Use realistic metal surfaces with believable reflections, clean joins, and a manufacturable furniture finish.';
  }

  if (material === 'glass') {
    return 'Use realistic glass with structure and mullions driven by the sketch; reflections stay controlled and subordinate to form read.';
  }

  if (material === 'fabric') {
    return 'Use realistic upholstery or textile surfaces on sketch-indicated textile zones only; construction stays believable and manufacturable.';
  }

  return 'Use neutral realistic furniture materials that read directly from the sketch—no material redesign that changes the form.';
}

function buildCountInstruction(prompt = '') {
  const doorCount = detectDoorCount(prompt);
  const drawerCount = detectDrawerCount(prompt);
  const shelfCount = detectShelfCount(prompt);
  const parts = [];

  if (doorCount) {
    parts.push(`The object must have exactly ${doorCount} visible door${doorCount > 1 ? 's' : ''}.`);
  }
  if (drawerCount) {
    parts.push(`The object must have exactly ${drawerCount} visible drawer${drawerCount > 1 ? 's' : ''}.`);
  }
  if (shelfCount) {
    parts.push(`The object must show exactly ${shelfCount} visible shelf/shelves or compartment sections matching sketch-indicated segmentation.`);
  }

  if (!parts.length) {
    return 'Preserve the visible structural segmentation from the sketch exactly. Do not invent extra doors, drawers, or compartments.';
  }

  return parts.join(' ');
}

function buildStyleInstruction(prompt = '') {
  const styles = detectStyleHints(prompt);

  if (!styles.length) {
    return 'Keep the design clean, believable, and commercially realistic.';
  }

  return `User-requested style cues: ${styles.join(', ')}. Integrate them boldly while keeping sketch geometry locked.`;
}

function extractNegativeHints(prompt = '') {
  const text = prompt.toLowerCase();
  const negatives = [];

  if (text.includes('no handles')) negatives.push('Do not add handles.');
  if (text.includes('without handles')) negatives.push('Do not add handles.');
  if (text.includes('no legs')) negatives.push('Keep legs absent—match the sketch exactly.');
  if (text.includes('wall mounted')) negatives.push('Wall-mounted only—omit floor-standing supports.');
  if (text.includes('floating')) negatives.push('Keep the design visually floating or wall-mounted per the brief.');

  return negatives.length ? negatives.join(' ') : 'Do not add unsupported extra details.';
}

function buildProductVariationInstruction(_basePrompt = '', variationIndex = 0) {
  const seed = Math.floor(Math.random() * 1000000);

  if (!variationIndex) {
    return `Variation seed: ${seed}.`;
  }

  return `Create a clearly distinct alternative while preserving the same core object idea. Variation index: ${variationIndex}. Variation seed: ${seed}. Push different proportions, material treatment, edge language, panel emphasis, or leg/support details—stay inside the same product category and sketch structure.`;
}

export function buildGenerationMode(mode = 'balanced') {
  if (mode === 'fast') {
    return {
      label: 'fast',
      renderInstruction: 'Prioritize a clean result and low latency. Keep composition simple and direct.',
      apiSize: '1024x1024',
    };
  }

  if (mode === 'premium') {
    return {
      label: 'premium',
      renderInstruction: 'Prioritize richer material detail and a stronger premium product-photography feel.',
      apiSize: '1024x1024',
    };
  }

  return {
    label: 'balanced',
    renderInstruction: 'Balance speed, cost, and visual quality. Keep the result clean and commercially polished.',
    apiSize: '1024x1024',
  };
}

function buildArchitectVariationInstruction(variationIndex = 0) {
  const seed = Math.floor(Math.random() * 1000000);
  if (!variationIndex) {
    return `Variation seed: ${seed}.`;
  }
  return `Create a clearly distinct alternative while preserving the same core architectural idea. Variation index: ${variationIndex}. Variation seed: ${seed}. Push different spatial staging, façade rhythm, plaster/concrete/glass/steel ratios, volumetric cuts, or site context—zero slide back toward product or decor catalog framing; massing stays locked to the sketch.`;
}

function buildMechanicalVariationInstruction(variationIndex = 0) {
  const seed = Math.floor(Math.random() * 1000000);
  if (!variationIndex) {
    return `Variation seed: ${seed}.`;
  }
  return `Create a clearly distinct engineering alternative while preserving identical functional geometry. Variation index: ${variationIndex}. Variation seed: ${seed}. Rebalance fastener visibility, surface finish, exploded spacing, sectional hints, joint exposure, material stackups, or labeling density—engineering read must get stronger, not prettier; zero topology or proportion drift.`;
}

function buildArtistVariationInstruction(variationIndex = 0) {
  const seed = Math.floor(Math.random() * 1000000);
  if (!variationIndex) {
    return `Variation seed: ${seed}.`;
  }
  return `Create a clearly distinct stylistic interpretation while keeping the same subject identity. Variation index: ${variationIndex}. Variation seed: ${seed}. Swing palette, lighting drama, brush economy, shape exaggeration, and negative space hard—same subject DNA, radically different art read.`;
}

function buildProductSketchPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const material = detectMaterial(safePrompt);
  const furnitureType = detectFurnitureType(safePrompt);
  const materialInstruction = buildMaterialInstruction(material, safePrompt);
  const colors = detectColors(safePrompt);
  const colorInstruction = buildColorInstruction(colors);
  const countInstruction = buildCountInstruction(safePrompt);
  const styleInstruction = buildStyleInstruction(safePrompt);
  const negativeHints = extractNegativeHints(safePrompt);
  const variationInstruction = buildProductVariationInstruction(safePrompt, variationIndex);
  const mode = buildGenerationMode(generationMode);

  return `
ROLE — PRODUCT MODE:
You are a senior industrial designer and catalog photographer. This is the least interpretive mode: safest, most literal, most commercially confident output.

TASK TYPE:
Sketch-to-image reconstruction for a ${furnitureType}.

USER DESCRIPTION:
${safePrompt || 'No additional description provided.'}

DO — PRODUCT MODE:
- Lock the sketch concept: preserve silhouette, proportions, segmentation, and perspective
- Deliver catalog-grade photorealism: believable materials, crisp edges, well-resolved proportions
- Frame as sell-through product or disciplined interior product photography—clean composition, production-ready credibility
- Prioritize literal realism and manufacturability; ban creative reinterpretation
- Treat visible sketch lines as physical edges, panel splits, or boundaries
- ${styleInstruction}
- ${negativeHints}

DO NOT — PRODUCT MODE:
- Do not stylize, abstract, or art-direct beyond faithful execution
- Do not exaggerate shapes for drama or expression
- Do not reinterpret the sketch into architecture, engineering teardowns, or concept art
- Do not redesign into a prettier generic object—stay faithful to the sketch idea
- Do not simplify unusual geometry or remove asymmetry

COUNT AND STRUCTURE:
- ${countInstruction}
- Preserve panels, dividers, supports, openings; invent zero extra compartments or ornament

MATERIAL AND COLOR:
- ${materialInstruction}
- ${colorInstruction}

REALISM:
- Shelf-ready, mass-producible read; joins and construction support the visible design without changing segmentation

RENDER:
- Neutral or clean commercial backdrop; soft controlled studio-style lighting; strong material read
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE — PRODUCT MODE:
REALISTIC, COMMERCIALLY USABLE, PRODUCTION-READY—NO STYLIZATION.
`;
}

function buildProductTextOnlyPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const material = detectMaterial(safePrompt);
  const furnitureType = detectFurnitureType(safePrompt);
  const materialInstruction = buildMaterialInstruction(material, safePrompt);
  const colors = detectColors(safePrompt);
  const colorInstruction = buildColorInstruction(colors);
  const countInstruction = buildCountInstruction(safePrompt);
  const styleInstruction = buildStyleInstruction(safePrompt);
  const negativeHints = extractNegativeHints(safePrompt);
  const variationInstruction = buildProductVariationInstruction(safePrompt, variationIndex);
  const mode = buildGenerationMode(generationMode);

  return `
ROLE — PRODUCT MODE:
You are a professional industrial designer and product visualization lead. Commercial baseline only: literal, polished, sellable, minimally interpretive.

OBJECT TYPE:
${furnitureType}

USER DESCRIPTION:
${safePrompt}

DO — PRODUCT MODE:
- Honor explicit structure, layout, and counts from the user text
- Build one coherent, manufacturable object or interior product moment with catalog-grade realism
- Use commercially believable materials and lighting; resolve proportions cleanly
- Prioritize literal realism; zero art-direction drift
- ${styleInstruction}
- ${negativeHints}

DO NOT — PRODUCT MODE:
- Do not stylize, abstract, or reinterpret as architecture, engineering concept art, or painterly illustration
- Do not exaggerate silhouettes for artistic drama
- Do not drift into generic decor fantasy unrelated to the brief

STRUCTURE:
- ${countInstruction}
- Invent zero extra doors, drawers, shelves, or supports beyond the described layout

MATERIAL AND COLOR:
- ${materialInstruction}
- ${colorInstruction}

RENDER:
- Product photography discipline: neutral clean background, soft studio light, realistic shadows, high edge clarity
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE — PRODUCT MODE:
REALISTIC, COMMERCIALLY USABLE, PRODUCTION-READY—NO STYLIZATION.
`;
}

function buildArchitectSketchPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildArchitectVariationInstruction(variationIndex);

  return `
ROLE — ARCHITECT MODE:
You are a licensed architect and architectural visualizer. Every deliverable is a built room, volume, or site-bound architecture—not an object render.

PRIMARY READ:
Interpret the sketch as spatial design: interior architecture, built form, installation, pavilion, façade logic, or gallery sequence. Furniture, vehicles, or gadgets inform massing and rhythm only—they sit inside a real architectural environment, never as isolated hero products.

USER DESCRIPTION (context):
${safePrompt || 'No additional description provided—still deliver a full room or architectural volume.'}

MANDATORY ENVIRONMENT (NON-NEGOTIABLE):
- The result MUST include a full spatial environment: a readable floor plane, readable wall planes (or continuous perimeter enclosure), and clear spatial depth receding into the scene
- Always include lighting context: daylight, gallery light, or architectural interior lighting with shadows that prove volume on floors and walls
- Never output isolated furniture or objects on an empty, seamless, cyclorama, or studio-neutral background

OBJECT OVERRIDE:
- Treat every sketched object as part of architectural composition: integrate it into the space—grounded on or relative to the floor, bounded by walls, spatially anchored—never catalog-centered on a void

PRIORITY (SPACE OVER OBJECT):
- Enclosure, openings, circulation, ceiling, material planes, and volumetric depth outweigh any single prop
- Shadow depth and volumetric composition outweigh styling polish

DO — ARCHITECT MODE:
- Build with board-formed concrete, plaster, large glass, steel structure, architectural timber as spatial surfaces—not retail staging
- Add windows, openings, doorways, or façade cuts so the read is unmistakably architectural space
- Wide or medium architectural camera; sketch locks massing breaks and voids; grow architecture from that diagram inside the enforced environment

DO NOT — ARCHITECT MODE:
- Do not render a product shot, studio sweep, seamless void, or catalog-centered display
- Do not use neutral studio backgrounds or single-object e-commerce framing
- Do not produce furniture-on-empty-background, floating props, lifestyle islands, or merchandising vignettes without full room enclosure
- Do not chase product sparkle; enclosure and depth lead

ATMOSPHERE:
- Strong directional or architectural light, readable shadows on floor and walls, specular glass, tactile concrete and plaster grain

RENDER:
- Interior room, pavilion volume, plaza edge, urban slot, or landscape-locked architecture—always a real place with floor, walls, and depth
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE — ARCHITECT MODE:
This MUST be a full architectural space with floor, walls, and depth. Never a product render.
`;
}

function buildArchitectTextOnlyPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildArchitectVariationInstruction(variationIndex);

  return `
ROLE — ARCHITECT MODE:
You are an architect and architectural CGI director. Every image is a real architectural space or site-bound volume—not merchandise, not a product plate.

USER DESCRIPTION:
${safePrompt || 'No additional description provided—still deliver a full room or site with architectural depth.'}

PRIMARY READ:
Turn any brief into architecture: room architecture, façade study, pavilion, atrium, installation, or structural concept. Objects and furniture are never the end goal—space, enclosure, and depth are.

MANDATORY ENVIRONMENT (NON-NEGOTIABLE):
- The result MUST show a full spatial environment: floor plane, wall planes (or perimeter enclosure), and clear depth into the volume or site
- Always include lighting context with shadows that read on floors and walls—daylight, gallery light, or designed interior lighting
- Never output isolated furniture or objects on empty, seamless, cyclorama, or studio-neutral backgrounds

OBJECT OVERRIDE:
- Integrate any described furniture or object into the architecture: relate it to floor and walls, ground it spatially—never isolate it for catalog display

PRIORITY (STRUCTURE OVER DECOR):
- Massing, enclosure, openings, circulation, material planes, and light in volume beat accessory styling
- Volumetric depth and daylight legibility beat catalog polish

DO — ARCHITECT MODE:
- Material bias: concrete, plaster, glass, steel, architectural timber as spatial surfaces defining rooms or volumes
- Show windows, openings, doorways, or façade logic so enclosure and depth are undeniable
- One coherent occupiable scene: floor, walls, ceiling or sky, deep shadows, spatial layering

DO NOT — ARCHITECT MODE:
- Do not ship product shots, studio sweeps, catalog hero framing, or furniture-on-empty-background
- Do not center objects for e-commerce display or use neutral voids without architectural surfaces
- Do not optimize for decor vignettes or boutique shelf appeal at the expense of full spatial enclosure

COMPOSITION:
- Cantilever drama, façade relief, long corridors, double-height cuts, sculptural stair or volume intersections—all inside readable architecture

RENDER:
- Lighting serves volumetric architecture and depth—not product sparkle
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE — ARCHITECT MODE:
This MUST be a full architectural space with floor, walls, and depth. Never a product render.
`;
}

function buildMechanicalSketchPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildMechanicalVariationInstruction(variationIndex);

  return `
ROLE — MECHANICAL MODE:
You are a mechanical engineer, industrial engineer, and technical concept designer. Function, assembly logic, and construction read drive every pixel—appearance is secondary.

INTERPRETATION:
Read the sketch as a mechanical system: housings, frames, ribs, shafts, brackets, supports, hinges, seals, fasteners, interfaces, mechanical seams, mounting logic, parting lines, and load paths must read clearly.

USER DESCRIPTION:
${safePrompt || 'No additional description provided—still deliver a full engineered-system read.'}

DO — MECHANICAL MODE:
- Expose joints, fasteners, brackets, interfaces, wall-thickness steps, bosses, cable exits; add heat-sink fins on forms that read as thermal hardware
- Emphasize manufacturable surfaces: machined, cast, formed, bead-blasted, anodized, oxide—industrial metal, composite, rubber, matte engineering plastics
- Show assembly order and component relationships: mild exploded spacing, ghosted mates, or sectional clarity—one coherent prototype system
- Specular highlights explain geometry—never glam lighting

DO NOT — MECHANICAL MODE:
- Do not beautify into minimal lifestyle renders or decor-first polish
- Do not smooth away mechanical segmentation, fasteners, or interface logic
- Do not optimize for showroom appeal, architecture, or saturated concept-art palettes
- Do not use furniture marketing visuals unless the user text explicitly demands that framing

SKETCH LOCK:
- Topology, proportions, holes, symmetry, segmentation stay tied to the sketch—no cartoon simplification

RENDER:
- Industrial gray or lab-neutral backdrop; at most a faint grid for legibility—default to none
- High edge contrast, documentary lighting, callout-friendly detail density
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE — MECHANICAL MODE:
ENGINEERED TECHNICAL SYSTEM—NOT STYLING, NOT ARCHITECTURE, NOT CONCEPT-ART COLOR.
`;
}

function buildMechanicalTextOnlyPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildMechanicalVariationInstruction(variationIndex);

  return `
ROLE — MECHANICAL MODE:
You are a mechanical / industrial engineer plus technical visualization specialist. Design-review hardware, not mood boards or tasteful products.

USER DESCRIPTION:
${safePrompt || 'No additional description provided—still output a disciplined engineered system.'}

DO — MECHANICAL MODE:
- Translate the brief into components, interfaces, fasteners, frames, housings, supports, and mechanical seams users can trust
- Show assembly logic: stacked housings, bolted flanges, keyed shafts, bearings, cable exits, gaskets, structural members, mounting surfaces
- Factory palette: machined aluminum, steel, anodize, oxide, matte industrial polymer, rubber
- Mild exploded spacing, ghost mates, or sectional hints to expose anatomy—one coherent system

DO NOT — MECHANICAL MODE:
- Do not chase beauty-first decor, lifestyle softness, or minimal lifestyle polish
- Do not erase bolts, joints, or segmentation for a smoother silhouette
- Do not drift into architecture, gallery spatial fantasy, or colorful art direction
- Do not present as furniture catalog imagery unless the user explicitly requests that framing

RENDER:
- Neutral industrial environment, razor readability, documentary contrast, prototype credibility
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE — MECHANICAL MODE:
ENGINEERED TECHNICAL SYSTEM—NOT STYLING, NOT ARCHITECTURE, NOT CONCEPT-ART COLOR.
`;
}

function buildArtistSketchPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildArtistVariationInstruction(variationIndex);

  return `
ROLE — ARTIST MODE:
You are a concept artist, visual-development painter, and stylized illustrator. Art direction and visual character dominate—commerce does not.

MANDATE:
Transform the sketch into stylized concept art: preserve subject identity and compositional spine—then push exaggerated silhouette, mood, expressive form, and dramatic lighting through non-literal painterly or illustrative treatment.

USER DESCRIPTION:
${safePrompt || 'No additional description provided—still commit to a bold stylized interpretation.'}

DO — ARTIST MODE:
- Prioritize vis-dev / concept-art energy: stylized materials, expressive color, graphic shape language, storytelling atmosphere
- Warp proportions, perspective, or surface detail when it strengthens the art read—literal accuracy is optional
- Painterly, inked, or illustrative execution; rim light, colored bounce, volumetric beams, hard spots
- Backgrounds and mood support the narrative—materials may break physics for art

DO NOT — ARTIST MODE:
- Do not default to commercial realism, e-commerce polish, or “realistic render with a tint”
- Do not keep proportions, materials, and lighting overly literal when stylization would sharpen the direction
- Do not play safe with neutral palettes, symmetrical showroom framing, or product-catalog neutrality
- Do not output anything mistakable for PRODUCT MODE

SKETCH TETHER:
- Same subject identity and spine—no unrelated objects

RENDER:
- Illustration-first finish; visible artistic hand in every major pass
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE — ARTIST MODE:
STYLIZED CONCEPT ART—NOT COMMERCIAL REALISM OR PRODUCT MODE.
`;
}

function buildArtistTextOnlyPrompt({ userPrompt = '', generationMode = 'balanced', variationIndex = 0 } = {}) {
  const safePrompt = normalizeText(userPrompt);
  const mode = buildGenerationMode(generationMode);
  const variationInstruction = buildArtistVariationInstruction(variationIndex);

  return `
ROLE — ARTIST MODE:
You are a concept artist and visual-development illustrator. Literal commercial rendering is failure—stylization is the deliverable.

USER DESCRIPTION:
${safePrompt || 'No additional description provided—still invent a striking stylized treatment for one clear subject.'}

DO — ARTIST MODE:
- Push concept-art graphic read, painterly surfaces, mood-first color, exaggerated silhouette, theatrical lighting
- Abstract or merge details when it amplifies visual character—non-literal transformation is required
- One focal idea, cohesive art system, high-energy visual development finish

DO NOT — ARTIST MODE:
- Do not deliver catalog realism, micro-perfect PBR polish, or “photo plus filter”
- Do not keep proportions and materials literal when stylization would improve art direction
- Do not aim for e-commerce neutrality, showroom safety, or product listings
- Do not produce imagery passable as PRODUCT MODE

RENDER:
- Cinematic crop, dynamic composition, art-first materials, visible stylization in every major pass
- ${mode.renderInstruction}

VARIATION CONTROL:
- ${variationInstruction}

FINAL RULE — ARTIST MODE:
STYLIZED CONCEPT ART—NOT COMMERCIAL REALISM OR PRODUCT MODE.
`;
}

export function buildModePrompt({
  mode,
  userPrompt,
  generationMode = 'balanced',
  variationIndex = 0,
  hasSketch = false,
} = {}) {
  const aiMode = normalizeMode(mode);

  if (aiMode === 'product') {
    return hasSketch
      ? buildProductSketchPrompt({ userPrompt, generationMode, variationIndex })
      : buildProductTextOnlyPrompt({ userPrompt, generationMode, variationIndex });
  }

  if (aiMode === 'architect') {
    return hasSketch
      ? buildArchitectSketchPrompt({ userPrompt, generationMode, variationIndex })
      : buildArchitectTextOnlyPrompt({ userPrompt, generationMode, variationIndex });
  }

  if (aiMode === 'mechanical') {
    return hasSketch
      ? buildMechanicalSketchPrompt({ userPrompt, generationMode, variationIndex })
      : buildMechanicalTextOnlyPrompt({ userPrompt, generationMode, variationIndex });
  }

  if (aiMode === 'artist') {
    return hasSketch
      ? buildArtistSketchPrompt({ userPrompt, generationMode, variationIndex })
      : buildArtistTextOnlyPrompt({ userPrompt, generationMode, variationIndex });
  }

  return hasSketch
    ? buildProductSketchPrompt({ userPrompt, generationMode, variationIndex })
    : buildProductTextOnlyPrompt({ userPrompt, generationMode, variationIndex });
}
