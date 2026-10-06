'use strict';
/* ==========================================================================
   BOGOTÁ ESCAPE
   Juego 2D top-down de mundo abierto en una Bogotá estilizada (ficticia).
   Todo corre local: Canvas 2D + WebAudio + localStorage. Sin servidor.
   --------------------------------------------------------------------------
   Índice
    1. Utilidades y configuración
    2. Datos del juego (barrios, vehículos, tiendas, mercados, misiones…)
    3. Audio (efectos y "radio" de cumbia generados con WebAudio)
    4. Entrada (teclado + controles táctiles)
    5. Generación de la ciudad
    6. Render de la ciudad (piso en caché por chunks, techos en vivo)
    7. Entidades: vehículos, peatones, jugador, policía
    8. Sistemas: tráfico, búsqueda policial, clima y hora
    9. Misiones y eventos aleatorios
   10. Economía, tiendas y menús
   11. HUD, minimapa y mapa grande
   12. Guardado
   13. Bucle principal e inicio
   ========================================================================== */

// ==========================================================================
// 1. UTILIDADES Y CONFIGURACIÓN
// ==========================================================================
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const approach = (v, target, step) => (v < target ? Math.min(v + step, target) : Math.max(v - step, target));
const angDiff = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
const fmtMoney = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const round500 = n => Math.round(n / 500) * 500;

/** Generador pseudoaleatorio con semilla (la ciudad siempre es la misma). */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickR = (rng, arr) => arr[Math.floor(rng() * arr.length)];

/** Hash determinístico de dos enteros a [0,1): texturas sin guardar estado. */
function h2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Aclara (amt>0) u oscurece (amt<0) un color hex. */
function shade(hex, amt) {
  const c = parseInt(hex.slice(1), 16);
  let r = c >> 16, g = (c >> 8) & 255, b = c & 255;
  if (amt < 0) { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
  else { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

// --- Medidas del mundo ---
const T = 32;            // tamaño de un tile (px de mundo)
const P = 16;            // cada 16 tiles hay una calle
const RW = 3;            // ancho de la calle en tiles (2 carriles + separador)
const BX = 10, BY = 8;   // manzanas en X y en Y
const PT = P * T;        // 512 px entre calles
const MW = BX * P + RW;  // ancho del mapa en tiles
const MH = BY * P + RW;  // alto del mapa en tiles
const WORLD_W = MW * T, WORLD_H = MH * T;
const MIN_PER_SEC = 2;   // minutos de juego por segundo real (1 día = 12 min)
const SAVE_KEY = 'bogotaEscape.save.v1';

const TILE = { ROAD: 0, SIDEWALK: 1, BUILDING: 2, GRASS: 3, PLAZA: 4, WATER: 5, TREE: 6, RUNWAY: 7, APRON: 8, SAND: 9 };
const SOLID_LUT = [0, 0, 1, 0, 0, 1, 1, 0, 0, 0];
const DIRV = [[1, 0], [0, 1], [-1, 0], [0, -1]];            // E S O N
const DIR_ANG = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

// ==========================================================================
// 2. DATOS DEL JUEGO
// ==========================================================================

/** Barrios: reputación necesaria para entrar y color en el mapa. */
const BOG_DISTRICTS = {
  K: { name: 'Kennedy', rep: 0, color: '#d08b4f', tagline: 'Donde arranca todo, parce.' },
  D: { name: 'Centro', rep: 0, color: '#9aa3b0', tagline: 'Rascacielos, afán y San Victorino.' },
  L: { name: 'La Candelaria', rep: 0, color: '#e2b84a', tagline: 'Casitas de colores y calles empedradas.' },
  C: { name: 'Chapinero', rep: 5, color: '#c96a40', tagline: 'Ladrillo, cafecitos y parche bohemio.' },
  S: { name: 'Suba', rep: 10, color: '#86b55f', tagline: 'Humedales, lomas y barrio.' },
  A: { name: 'Aeropuerto El Dorado', rep: 15, color: '#9fb4c8', tagline: 'Vuelos, turistas y puro afán.' },
  Z: { name: 'Zona T', rep: 20, color: '#c35bd6', tagline: 'Rumba, neón y gente con plata.' },
  U: { name: 'Usaquén', rep: 30, color: '#55b082', tagline: 'Colonial, tranquilo y muy caché.' },
};
/** Barrio de cada manzana (10 columnas x 8 filas). Norte arriba, cerros al oriente. */
const BOG_GRID = [
  'SSSSUUUUUU',
  'SSSSUUUUUU',
  'AASSCZZZUU',
  'AAKCCZZZCC',
  'AAKCCCCCCC',
  'AAKKDDDLLL',
  'KKKKDDDLLL',
  'KKKKDDDLLL',
];

/** Estilo de construcción por barrio. */
const BOG_STYLE = {
  K: { minS: 3, gap: 0.35, empty: 0.1, court: 0.12, h: [8, 16], roofs: ['#b5523b', '#9c4a35', '#8a8f99', '#6f7d8c', '#c46a3c', '#a65d3f'], walls: ['#a0472f', '#8c3d2a', '#b8603e'], kind: 'tanks' },
  D: { minS: 4, gap: 0.3, empty: 0.06, court: 0, h: [28, 60], roofs: ['#8c929c', '#7a828e', '#9aa3ad', '#6b7380', '#a2a8b0'], walls: ['#5a616c', '#4a515b', '#666d78'], kind: 'ac' },
  L: { minS: 3, gap: 0.18, empty: 0.04, court: 0, h: [8, 14], roofs: ['#c0582f', '#b14d2a', '#cc6a3a', '#b8532d'], walls: ['#f2c94c', '#6fa8dc', '#93c47d', '#e06666', '#f6f1e7', '#c27ba0', '#f6b26b'], kind: 'tejas' },
  C: { minS: 3, gap: 0.3, empty: 0.06, court: 0.03, h: [16, 32], roofs: ['#8d6e63', '#7a6157', '#a1887f', '#6d6d6d', '#94705e'], walls: ['#b3542f', '#9e4a2a', '#a8502d'], kind: 'terrace' },
  Z: { minS: 4, gap: 0.45, empty: 0.05, court: 0, h: [18, 40], roofs: ['#2b3a55', '#23415a', '#1f4e5f', '#33475b', '#2e3550'], walls: ['#18263a', '#1a3346', '#223044'], kind: 'glass' },
  U: { minS: 3, gap: 0.4, empty: 0.08, court: 0.02, h: [8, 18], roofs: ['#c0582f', '#a84a2c', '#7c8a5c', '#b86b45'], walls: ['#f4efe6', '#b3542f', '#e8dcc6'], kind: 'tejas' },
  S: { minS: 3, gap: 0.35, empty: 0.1, court: 0.1, h: [10, 22], roofs: ['#a35d43', '#8f5a48', '#7d7f86', '#b06f50', '#996049'], walls: ['#a8492e', '#93432c', '#b4583a'], kind: 'tanks' },
};

/** Manzanas que son parques o plazas. */
const BOG_PARKS = {
  '3,0': { kind: 'park', name: 'Parque Mirador' },
  '2,1': { kind: 'humedal', name: 'Humedal de Suba' },
  '7,0': { kind: 'usaquen', name: 'Parque de Usaquén' },
  '6,2': { kind: 'park93', name: 'Parque de la 93' },
  '4,3': { kind: 'park', name: 'Parque de los Hippies' },
  '7,5': { kind: 'plaza', name: 'Plaza de Bolívar' },
  '2,7': { kind: 'park', name: 'Parque Timiza' },
  '6,7': { kind: 'park', name: 'Parque Tercer Milenio' },
};

/** Vehículos: medidas en px, velocidades en px/s (×0.3 ≈ km/h). */
const VEH = {
  bici: { name: 'Bicicleta', len: 18, w: 7, max: 205, acc: 210, turn: 3.6, grip: 8, hp: 40, seats: 1, cap: 10, two: true, mass: 0.3, engine: false },
  moto: { name: 'Moto 125cc', len: 21, w: 8, max: 320, acc: 430, turn: 3.5, grip: 7.5, hp: 60, seats: 2, cap: 14, two: true, mass: 0.5, engine: true },
  motosport: { name: 'Moto deportiva', len: 23, w: 9, max: 410, acc: 580, turn: 3.6, grip: 7.5, hp: 70, seats: 2, cap: 12, two: true, mass: 0.55, engine: true },
  sedan: { name: 'Sedán', len: 30, w: 15, max: 290, acc: 300, turn: 2.7, grip: 5.5, hp: 100, seats: 4, cap: 30, mass: 1, engine: true },
  taxi: { name: 'Taxi', len: 30, w: 15, max: 290, acc: 300, turn: 2.7, grip: 5.5, hp: 100, seats: 4, cap: 30, mass: 1, engine: true },
  suv: { name: 'Camioneta', len: 34, w: 17, max: 285, acc: 280, turn: 2.4, grip: 6, hp: 160, seats: 5, cap: 45, mass: 1.4, engine: true },
  sport: { name: 'Deportivo', len: 31, w: 15, max: 430, acc: 580, turn: 3.0, grip: 6.5, hp: 110, seats: 2, cap: 15, mass: 1, engine: true },
  police: { name: 'Patrulla', len: 31, w: 15, max: 335, acc: 360, turn: 2.9, grip: 6, hp: 150, seats: 4, cap: 20, mass: 1.2, engine: true },
  bus: { name: 'Buseta SITP', len: 52, w: 19, max: 175, acc: 130, turn: 1.5, grip: 6, hp: 300, seats: 30, cap: 60, mass: 3, engine: true },
  tm: { name: 'TransMilenio', len: 84, w: 19, max: 200, acc: 120, turn: 1.2, grip: 6, hp: 600, seats: 150, cap: 0, mass: 5, engine: true, nodrive: true },
};
const CAR_COLORS = ['#d9d9d9', '#2b2b2b', '#b71c1c', '#1e5aa8', '#7a7f87', '#f0f0f0', '#5d4037', '#2e7d32', '#8e1b5a', '#c56a12'];
function defaultColor(type) {
  if (type === 'taxi') return '#ffd21f';
  if (type === 'police') return '#f4f6f4';
  if (type === 'bus') return '#1c64b5';
  if (type === 'tm') return CITY.troncal.color;
  if (type === 'bici') return pick(['#26a69a', '#e53935', '#fdd835', '#5e35b1']);
  return pick(CAR_COLORS);
}

/** Tiendas: e = energía, h = salud, cloth = ropa, veh = vehículo, phone = celular. */
const SHOPS = {
  empanadas: { name: 'Empanadas La Mona', icon: '🥟', color: '#ffb300', items: [
    { n: 'Empanada con ají', p: 2500, e: 14 },
    { n: 'Pastel de pollo', p: 4500, e: 24 },
    { n: 'Avena fría', p: 3000, e: 10, h: 3 }] },
  tinto: { name: 'Tinto y Pan', icon: '☕', color: '#a1887f', items: [
    { n: 'Tinto', p: 1500, e: 9 },
    { n: 'Pan de bono', p: 2000, e: 12 },
    { n: 'Chocolate con queso', p: 7000, e: 30, h: 5 }] },
  panaderia: { name: 'Panadería La Espiga', icon: '🥐', color: '#ffca28', items: [
    { n: 'Almojábana', p: 2500, e: 14 },
    { n: 'Roscón de arequipe', p: 3500, e: 18 },
    { n: 'Tinto', p: 1500, e: 9 }] },
  corrientazo: { name: 'Corrientazo Doña Marta', icon: '🍛', color: '#ff7043', items: [
    { n: 'Almuerzo ejecutivo', p: 14000, e: 55, h: 10 },
    { n: 'Jugo de lulo', p: 4500, e: 14, h: 2 }] },
  ajiaco: { name: 'El Santafereño', icon: '🍲', color: '#fdd835', items: [
    { n: 'Ajiaco santafereño', p: 28000, e: 85, h: 20 },
    { n: 'Changua', p: 12000, e: 40, h: 8 },
    { n: 'Tamal con chocolate', p: 18000, e: 60, h: 10 }] },
  gourmet: { name: 'Restaurante La 93', icon: '🍽️', color: '#ab47bc', items: [
    { n: 'Bandeja paisa', p: 48000, e: 100, h: 25 },
    { n: 'Hamburguesa gourmet', p: 36000, e: 70, h: 12 }] },
  drogueria: { name: 'Droguería', icon: '💊', color: '#66bb6a', items: [
    { n: 'Curitas y acetaminofén', p: 9000, h: 18 },
    { n: 'Botiquín completo', p: 32000, h: 50 },
    { n: 'Suero oral', p: 6000, e: 18, h: 6 }] },
  ropa: { name: 'Ropa San Victorino', icon: '👕', color: '#ec407a', items: [
    { n: 'Ruana boyacense', p: 65000, cloth: 'ruana', rep: 2, desc: 'Te abriga: la lluvia y el frío gastan menos energía.' },
    { n: 'Impermeable', p: 90000, cloth: 'impermeable', rep: 1, desc: 'La lluvia ya no te cansa cuando vas a pie.' },
    { n: 'Tenis "originales"', p: 110000, cloth: 'tenis', rep: 2, desc: 'Corres 12% más rápido.' }] },
  boutique: { name: 'Boutique Zona T', icon: '🕶️', color: '#7e57c2', items: [
    { n: 'Gafas de sol', p: 180000, cloth: 'gafas', rep: 4, desc: 'Puro estilo.' },
    { n: 'Pinta elegante', p: 480000, cloth: 'pinta', rep: 6, desc: 'Entrada VIP en la rumba: sin cover y más reputación.' },
    { n: 'Chaqueta de cuero', p: 650000, cloth: 'cuero', rep: 8, desc: 'Respeto en la calle.' }] },
  celulares: { name: 'Celulares San Andresito', icon: '📱', color: '#29b6f6', items: [
    { n: 'Celular básico', p: 180000, phone: 1, desc: 'Recibe domicilios desde cualquier parte (tecla C).' },
    { n: 'Smartphone gama alta', p: 850000, phone: 2, desc: 'Domicilios mejor pagados (+25%).' }] },
  bicis: { name: 'Bicicletería El Pedalazo', icon: '🚲', color: '#26a69a', items: [
    { n: 'Bicicleta', p: 250000, veh: 'bici', desc: 'Mucho más rápida que caminar. Ideal para domicilios.' }] },
  motos: { name: 'Motos La 68', icon: '🏍️', color: '#ef6c00', items: [
    { n: 'Moto 125cc', p: 1500000, veh: 'moto', desc: 'La reina de Bogotá: rápida y se mete por todo lado.' },
    { n: 'Moto deportiva', p: 4200000, veh: 'motosport', desc: 'Para los que viven con afán.' }] },
  carros: { name: 'Concesionario del Norte', icon: '🚗', color: '#5c6bc0', items: [
    { n: 'Carro usado', p: 5500000, veh: 'sedan', desc: 'Cuatro puestos y techo para el aguacero.' },
    { n: 'Camioneta', p: 13000000, veh: 'suv', desc: 'Aguanta huecos y estrellones.' },
    { n: 'Deportivo', p: 38000000, veh: 'sport', desc: 'El más rápido de la ciudad.' }] },
};

/** Viviendas: arriendo diario o compra. */
const HOMES = {
  kennedy: { name: 'Pieza en Kennedy', price: 0, rent: 8000, sleep: 70 },
  chapinero: { name: 'Apartaestudio en Chapinero', price: 3500000, rent: 0, sleep: 85 },
  usaquen: { name: 'Apartamento en Usaquén', price: 12000000, rent: 0, sleep: 100 },
  penthouse: { name: 'Penthouse en la Zona T', price: 35000000, rent: 0, sleep: 100 },
};

/** Negocios: dejan plata cada medianoche. */
const BIZ = {
  tienda: { name: 'Tienda de barrio "La Bendición"', price: 2000000, income: 130000, icon: '🏪' },
  foodtruck: { name: 'Food truck de arepas', price: 6000000, income: 420000, icon: '🫓' },
  parqueadero: { name: 'Parqueadero del Centro', price: 9000000, income: 650000, icon: '🅿️' },
  bar: { name: 'Bar "El Guaro" en la Zona T', price: 20000000, income: 1500000, icon: '🍸' },
};

/** Mercancía para revender. */
const GOODS = [
  { id: 'paraguas', n: 'Paraguas', icon: '☂️', base: 14000 },
  { id: 'mango', n: 'Mango biche', icon: '🥭', base: 4000 },
  { id: 'cargador', n: 'Cargadores', icon: '🔌', base: 16000 },
  { id: 'ropa', n: 'Ropa de paca', icon: '👕', base: 20000 },
  { id: 'flores', n: 'Flores de la Sabana', icon: '💐', base: 22000 },
  { id: 'cafe', n: 'Café de origen', icon: '☕', base: 28000 },
  { id: 'artesania', n: 'Artesanías', icon: '🧺', base: 38000 },
];
const GOOD = Object.fromEntries(GOODS.map(g => [g.id, g]));
const MARKETS = {
  victorino: { name: 'San Victorino', desc: 'Todo al por mayor y barato.', m: { paraguas: 0.62, mango: 0.8, cargador: 0.55, ropa: 0.5, flores: 0.9, cafe: 0.85, artesania: 0.8 } },
  corabastos: { name: 'Corabastos', desc: 'La central de abastos: comida y flores baratas.', m: { paraguas: 0.9, mango: 0.45, cargador: 0.95, ropa: 0.9, flores: 0.55, cafe: 0.7, artesania: 1.0 } },
  suba: { name: 'Feria de Suba', desc: 'Mercado de barrio, precios normales.', m: { paraguas: 1.05, mango: 1.1, cargador: 1.1, ropa: 1.15, flores: 0.75, cafe: 1.05, artesania: 1.05 } },
  candelaria: { name: 'Toldos de La Candelaria', desc: 'Turistas por todo lado.', m: { paraguas: 1.2, mango: 1.35, cargador: 1.05, ropa: 1.1, flores: 1.2, cafe: 1.45, artesania: 1.4 } },
  zonat: { name: 'Puestos de la Zona T', desc: 'Gente con plata y afán.', m: { paraguas: 1.45, mango: 1.4, cargador: 1.55, ropa: 1.2, flores: 1.65, cafe: 1.3, artesania: 1.25 } },
  pulgas: { name: 'Mercado de Pulgas de Usaquén', desc: 'Lleno de turistas y cachacos.', m: { paraguas: 1.25, mango: 1.2, cargador: 1.15, ropa: 1.45, flores: 1.4, cafe: 1.55, artesania: 1.75 } },
};

/** Misiones: reputación mínima para que te las den. */
const MISSION_INFO = {
  delivery: { title: 'Domicilio Express', icon: '🛵', rep: 0, color: '#ff6f3c', desc: 'Recoge el pedido y entrégalo antes de que se enfríe. Si te estrellas, la comida llega vuelta nada y te pagan menos.' },
  hustle: { title: 'Negocio en San Victorino', icon: '💰', rep: 0, color: '#ffd54f', desc: 'Un cliente quiere mercancía. Cómprala barata en cualquier mercado y llévasela antes de que se arrepienta.' },
  tmrace: { title: 'Carrera contra el TransMilenio', icon: '🚌', rep: 10, color: '#e53935', desc: 'Apostaste que llegabas al Portal Norte antes que el articulado. Arranca en el Portal Américas. ¡No pierda, mijo!' },
  airport: { title: 'Afán al Aeropuerto', icon: '✈️', rep: 15, color: '#4fc3f7', desc: 'Un turista va tarde para su vuelo. Llévalo a El Dorado rápido pero sin volverlo nada. Necesitas carro o moto.' },
  rumba: { title: 'Rumba en la Zona T', icon: '🍻', rep: 20, color: '#d05ce3', desc: 'El parche sale de rumba. Saca plata, compra las polas, recoge a los amigos y llega a la discoteca antes de las 11:30 p.m. Cover: $40.000.' },
  diluvio: { title: 'El Diluvio', icon: '🌧️', rep: 25, color: '#64b5f6', desc: 'Se viene el aguacero del año. Rescata a 3 personas varadas y llévalas a su casa antes de que la ciudad colapse.' },
  volada: { title: 'La Volada', icon: '🚨', rep: 35, color: '#ff5252', desc: 'El Flaco necesita que le "recojas" un carro. Va a sonar la alarma: pierde a la policía y entra al taller sin estrellas.' },
};

/** Logros. */
const ACH = {
  first_delivery: { n: 'Primer domicilio', d: 'Entrega tu primer pedido.', i: '🛵' },
  rolo: { n: 'Rolo de verdad', d: 'Visita los 8 barrios.', i: '🗺️' },
  fugitive: { n: 'Fugitivo', d: 'Escápate de la policía con 3 estrellas.', i: '🚨' },
  biz: { n: 'Empresario', d: 'Compra un negocio.', i: '🏪' },
  home: { n: 'Propietario', d: 'Compra un apartamento.', i: '🏠' },
  moto: { n: 'Motero', d: 'Compra tu primera moto.', i: '🏍️' },
  rich: { n: 'Millonario', d: 'Junta $10.000.000.', i: '💰' },
  tm: { n: 'Más rápido que el TM', d: 'Gánale al TransMilenio.', i: '🚌' },
  rumba: { n: 'Rumbero', d: 'Termina la rumba en la Zona T.', i: '🍻' },
  flood: { n: 'Sobreviviente del diluvio', d: 'Completa El Diluvio.', i: '🌧️' },
  hustler: { n: 'Comerciante', d: 'Gana $500.000 negociando.', i: '💼' },
  pothole: { n: 'Cazahuecos', d: 'Cae en 25 huecos.', i: '🕳️' },
  legend: { n: 'Leyenda de la calle', d: 'Llega a 100 de reputación.', i: '⭐' },
};

/** Puntos de interés: manzana [col, fila], lado de la acera y posición. */
const BOG_POIS = [
  // Viviendas
  { id: 'home_kennedy', type: 'home', home: 'kennedy', b: [1, 6], side: 'E', off: 6 },
  { id: 'home_chapinero', type: 'home', home: 'chapinero', b: [3, 3], side: 'E', off: 6 },
  { id: 'home_usaquen', type: 'home', home: 'usaquen', b: [8, 1], side: 'S', off: 6 },
  { id: 'home_penthouse', type: 'home', home: 'penthouse', b: [5, 2], side: 'S', off: 6 },
  // Comida
  { id: 'f1', type: 'shop', shop: 'empanadas', b: [2, 6], side: 'S', off: 4 },
  { id: 'f2', type: 'shop', shop: 'corrientazo', b: [5, 5], side: 'S', off: 4 },
  { id: 'f3', type: 'shop', shop: 'tinto', b: [8, 6], side: 'W', off: 5 },
  { id: 'f4', type: 'shop', shop: 'ajiaco', b: [8, 5], side: 'N', off: 8 },
  { id: 'f5', type: 'shop', shop: 'gourmet', b: [7, 3], side: 'W', off: 4 },
  { id: 'f6', type: 'shop', shop: 'empanadas', b: [3, 4], side: 'S', off: 3 },
  { id: 'f7', type: 'shop', shop: 'tinto', b: [1, 1], side: 'S', off: 5 },
  { id: 'f8', type: 'shop', shop: 'panaderia', b: [6, 0], side: 'S', off: 5 },
  { id: 'f9', type: 'shop', shop: 'corrientazo', b: [0, 7], side: 'N', off: 9 },
  { id: 'f10', type: 'shop', shop: 'panaderia', b: [1, 6], side: 'S', off: 8 },
  // Salud y autoridad
  { id: 'ph1', type: 'shop', shop: 'drogueria', b: [3, 7], side: 'N', off: 4 },
  { id: 'ph2', type: 'shop', shop: 'drogueria', b: [5, 4], side: 'E', off: 5 },
  { id: 'hosp1', type: 'hospital', b: [6, 5], side: 'N', off: 6 },
  { id: 'hosp2', type: 'hospital', b: [8, 0], side: 'S', off: 3 },
  { id: 'police1', type: 'police', b: [4, 6], side: 'E', off: 8 },
  // Ropa y celulares
  { id: 'cl1', type: 'shop', shop: 'ropa', b: [5, 6], side: 'S', off: 3 },
  { id: 'cl2', type: 'shop', shop: 'boutique', b: [5, 3], side: 'E', off: 6 },
  { id: 'cel', type: 'shop', shop: 'celulares', b: [6, 6], side: 'N', off: 8 },
  // Vehículos
  { id: 'bikes', type: 'shop', shop: 'bicis', b: [3, 6], side: 'N', off: 8 },
  { id: 'motos', type: 'shop', shop: 'motos', b: [6, 4], side: 'S', off: 6 },
  { id: 'cars', type: 'shop', shop: 'carros', b: [8, 3], side: 'S', off: 6 },
  { id: 'mech1', type: 'mechanic', b: [2, 5], side: 'E', off: 4 },
  { id: 'mech2', type: 'mechanic', b: [7, 4], side: 'N', off: 6 },
  { id: 'wash1', type: 'carwash', b: [3, 5], side: 'S', off: 8 },
  { id: 'wash2', type: 'carwash', b: [9, 4], side: 'W', off: 6 },
  { id: 'wash3', type: 'carwash', b: [1, 0], side: 'E', off: 6 },
  // Mercados
  { id: 'm_victorino', type: 'market', market: 'victorino', b: [5, 6], side: 'E', off: 6 },
  { id: 'm_corabastos', type: 'market', market: 'corabastos', b: [0, 6], side: 'S', off: 6 },
  { id: 'm_pulgas', type: 'market', market: 'pulgas', b: [7, 0], side: 'S', off: 6 },
  { id: 'm_zonat', type: 'market', market: 'zonat', b: [5, 2], side: 'E', off: 4 },
  { id: 'm_suba', type: 'market', market: 'suba', b: [2, 2], side: 'N', off: 6 },
  { id: 'm_cande', type: 'market', market: 'candelaria', b: [8, 7], side: 'N', off: 5 },
  // Negocios en venta
  { id: 'biz_tienda', type: 'business', biz: 'tienda', b: [1, 7], side: 'N', off: 6 },
  { id: 'biz_parq', type: 'business', biz: 'parqueadero', b: [4, 7], side: 'E', off: 6 },
  { id: 'biz_truck', type: 'business', biz: 'foodtruck', b: [4, 4], side: 'S', off: 8 },
  { id: 'biz_bar', type: 'business', biz: 'bar', b: [7, 2], side: 'S', off: 5 },
  // Quienes dan misiones
  { id: 'g_domi', type: 'giver', mission: 'delivery', b: [2, 6], side: 'W', off: 6, npc: 'Central de Domicilios' },
  { id: 'g_hustle', type: 'giver', mission: 'hustle', b: [5, 6], side: 'E', off: 9, npc: 'Don Ramiro' },
  { id: 'g_tm', type: 'giver', mission: 'tmrace', b: [0, 6], side: 'N', off: 9, npc: 'El Apostador' },
  { id: 'g_rumba', type: 'giver', mission: 'rumba', b: [4, 2], side: 'S', off: 6, npc: 'El Parce' },
  { id: 'g_air', type: 'giver', mission: 'airport', b: [8, 4], side: 'W', off: 6, npc: 'Hotel Andino Inn' },
  { id: 'g_diluvio', type: 'giver', mission: 'diluvio', b: [6, 5], side: 'W', off: 8, npc: 'Doña Gloria' },
  { id: 'g_volada', type: 'giver', mission: 'volada', b: [9, 6], side: 'W', off: 6, npc: 'El Flaco' },
  // Destinos especiales
  { id: 'club', type: 'club', b: [6, 3], side: 'N', off: 6 },
  { id: 'atm1', type: 'atm', b: [3, 3], side: 'S', off: 3 },
  { id: 'atm2', type: 'atm', b: [5, 4], side: 'N', off: 4 },
  // Escondites para perder a la policía
  { id: 'hide1', type: 'hide', b: [2, 5], side: 'W', off: 9 },
  { id: 'hide2', type: 'hide', b: [5, 7], side: 'S', off: 9 },
  { id: 'hide3', type: 'hide', b: [8, 6], side: 'S', off: 3 },
  { id: 'hide4', type: 'hide', b: [3, 3], side: 'N', off: 9 },
  { id: 'hide5', type: 'hide', b: [1, 1], side: 'E', off: 9 },
  { id: 'hide6', type: 'hide', b: [6, 1], side: 'W', off: 9 },
  { id: 'hide7', type: 'hide', b: [5, 3], side: 'W', off: 9 },
  { id: 'hide8', type: 'hide', b: [8, 4], side: 'N', off: 3 },
  { id: 'hide9', type: 'hide', b: [0, 7], side: 'E', off: 4 },
];

/** Estaciones de TransMilenio (sobre la Av. Américas y la Av. Caracas). */
const BOG_STATIONS = [
  { name: 'Portal Américas', tx: 8, ty: 99, axis: 'h' },
  { name: 'Kennedy', tx: 40, ty: 99, axis: 'h' },
  { name: 'San Victorino', tx: 88, ty: 99, axis: 'h' },
  { name: 'Universidades', tx: 136, ty: 99, axis: 'h' },
  { name: 'Calle 26', tx: 67, ty: 88, axis: 'v' },
  { name: 'Calle 45', tx: 67, ty: 72, axis: 'v' },
  { name: 'Calle 72', tx: 67, ty: 40, axis: 'v' },
  { name: 'Portal Norte', tx: 63, ty: 8, axis: 'v' },
];

/** Nomenclatura bogotana: calles de oriente a occidente, carreras de norte a sur. */
function calleName(j) { return j === 6 ? CITY.avH : 'Calle ' + ((BY - j) * 10 + 8); }
function carreraName(i) { return i === 4 ? CITY.avV : 'Carrera ' + ((BX - i) * 7 + 3); }
function carreraNum(i) { return (BX - i) * 7 + 3; }
function calleNum(j) { return (BY - j) * 10 + 8; }
/** Dirección tipo "Calle 48 # 24-31" para un punto del mapa. */
function addressOf(x, y) {
  const j = clamp(Math.round((y - 48) / PT), 0, BY), i = clamp(Math.round((x - 48) / PT), 0, BX);
  const dy = Math.abs(y - (j * PT + 48)), dx = Math.abs(x - (i * PT + 48));
  const nn = 10 + Math.floor(h2(Math.floor(x), Math.floor(y)) * 80);
  if (dy <= dx) {
    const ii = clamp(Math.round((x - 48) / PT), 0, BX);
    return `${calleName(j)} # ${carreraNum(ii)}-${nn}`;
  }
  return `${carreraName(i)} # ${calleNum(j)}-${nn}`;
}

const RESTAURANT_NAMES = ['Arepas Doña Ceci', 'Pollos La Brasa', 'Pizzería Il Forno', 'Sushi Ichiban', 'Frutería Tropical', 'Hamburguesas El Mono', 'Asadero Los Llanos', 'Crepes y Más', 'Comidas Rápidas Mi Rancho', 'Tamales Doña Chava'];
const CLIENT_NAMES = ['Valentina', 'Andrés', 'Doña Luz', 'Camilo', 'Sebastián', 'Mariana', 'Don Jairo', 'Laura', 'Felipe', 'Natalia', 'Juan Pablo', 'Daniela'];
const TOURIST_LINES = ['Wow, ¡cuántas motos!', 'Is it always this traffic?', '¿Ajiaco? Yes please!', '¡Qué frío hace aquí!', 'Bogotá is beautiful, man!', '¿Eso es Monserrate?', 'Please, my flight!!', '¡Chévere, parce!'];
const HONK_LINES = ['¡Pite pues!', '¡Muévase, señor!', '¡Ay, qué trancón!', '¿Sí o qué?', '¡Uy, qué tal este!', '¡Pilas, pues!'];

// ==========================================================================
// 2b. CIUDADES DE COLOMBIA — cada una con sus barrios, comida, dichos y radio
// ==========================================================================

/** Kits de construcción reutilizables. */
const KIT = {
  brick: { minS: 3, gap: 0.3, empty: 0.06, court: 0.05, h: [14, 30], roofs: ['#9a5a40', '#8d6e63', '#a1664a', '#7a6157'], walls: ['#b3542f', '#a04a2b', '#bf6a3c'], kind: 'terrace' },
  comuna: { minS: 2, gap: 0.22, empty: 0.02, court: 0.05, h: [6, 12], roofs: ['#8a8f99', '#b5523b', '#6f7d8c', '#c46a3c', '#9e9e9e'], walls: ['#e53935', '#fdd835', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1'], kind: 'tanks', graffiti: true },
  glass: BOG_STYLE.Z,
  white: { minS: 4, gap: 0.4, empty: 0.05, court: 0, h: [30, 70], roofs: ['#e8e8e4', '#d9dcdf', '#f1efe9', '#cfd8dc'], walls: ['#b0bec5', '#cfd4d8', '#a7b4bc'], kind: 'ac' },
  colonial: { minS: 3, gap: 0.15, empty: 0.03, court: 0, h: [10, 18], roofs: ['#c0582f', '#b14d2a', '#cc6a3a', '#d27a45'], walls: ['#f2c94c', '#e8a33d', '#3f88c5', '#e86a92', '#69b578', '#f6f1e7', '#ff8a65'], kind: 'tejas', balcony: true },
  costa: { minS: 3, gap: 0.3, empty: 0.08, court: 0.08, h: [8, 18], roofs: ['#e0e0dc', '#c9c9c4', '#b5523b', '#d7a86e', '#bdbdb6'], walls: ['#f6d6a8', '#a8dadc', '#f4a6a6', '#fff1c1', '#b8e0b0', '#ce93d8'], kind: 'tanks' },
  centro: BOG_STYLE.D,
  verde: BOG_STYLE.U,
  barrio: BOG_STYLE.K,
};
const withK = (base, extra) => Object.assign({}, base, extra);

/** Lugares estándar que tiene toda ciudad (posición automática dentro del barrio indicado). */
function cityPOIs(c) {
  return [
    { id: 'hotel', type: 'home', home: 'hotel', d: c.hotel },
    ...c.food.map((f, i) => ({ id: 'food' + i, type: 'shop', shop: f[0], d: f[1] })),
    { id: 'drog', type: 'shop', shop: 'drogueria', d: c.misc[0] },
    { id: 'hosp1', type: 'hospital', d: c.misc[1] },
    { id: 'police1', type: 'police', d: c.misc[2] },
    { id: 'ropa', type: 'shop', shop: c.ropa[0], d: c.ropa[1] },
    { id: 'motos', type: 'shop', shop: 'motos', d: c.misc[3] },
    { id: 'bikes', type: 'shop', shop: 'bicis', d: c.misc[0] },
    { id: 'mech1', type: 'mechanic', d: c.misc[4] },
    { id: 'wash1', type: 'carwash', d: c.misc[5] },
    { id: 'armas', type: 'shop', shop: 'armas', d: c.misc[5] },
    { id: 'cel', type: 'shop', shop: 'celulares', d: c.misc[1] },
    { id: 'atm1', type: 'atm', d: c.misc[3] },
    { id: 'club', type: 'club', d: c.club[0], name: c.club[1] },
    ...c.markets.map((m, i) => ({ id: 'm_' + m[0], type: 'market', market: m[0], d: m[1] })),
    ...c.givers.map(g => Object.assign({ type: 'giver' }, g)),
    ...['hideA', 'hideB', 'hideC', 'hideD'].map((id, i) => ({ id, type: 'hide', d: c.hides[i % c.hides.length] })),
  ];
}

/** Bogotá también tiene misiones nuevas. */
BOG_POIS.push(
  { id: 'g_taxi', type: 'giver', mission: 'taxi', b: [4, 5], side: 'N', off: 4, npc: 'Don Pacho, el de los taxis' },
  { id: 'g_race', type: 'giver', mission: 'carrera', b: [7, 4], side: 'S', off: 4, npc: 'El Pique' },
  { id: 'g_gang', type: 'giver', mission: 'pandilla', b: [0, 7], side: 'S', off: 5, npc: 'La Junta de Acción Comunal' },
  { id: 'armas', type: 'shop', shop: 'armas', b: [3, 7], side: 'W', off: 9 },
);

const CITIES = {
  bogota: {
    id: 'bogota', name: 'Bogotá', nick: 'La Nevera', seed: 1538,
    districts: BOG_DISTRICTS, grid: BOG_GRID, style: BOG_STYLE, parks: BOG_PARKS, pois: BOG_POIS,
    stationNames: BOG_STATIONS.map(s => s.name),
    avH: 'Av. Américas', avV: 'Av. Caracas',
    troncal: { name: 'TransMilenio', short: 'TM', color: '#c8102e', lane: '#7b2d2d', fare: 2950 },
    airport: 'El Dorado', climate: 'frio', rain: 0.35, palms: false,
    outside: { N: 'sabana', S: 'sabana', W: 'sabana', E: 'mount' },
    radio: 1, price: 0,
    sayings: ['¡Qué más, sumercé!', '¡Uy, qué oso!', 'Ala, ¿sí o qué?', '¡Qué boleta, parce!', '¡Qué frío tan berraco!', 'Llegué tarde por el trancón, ¿sí me entiende?', '¡Chévere, parce!', '¿Me regala un tintico?', '¡Uy, se largó a llover otra vez!', 'Ese man es muy gomelo', '¡Qué chimba, parce!', '¡Pilas con el celular, ome!', '¿Una changüita o qué?', 'Hágale, que yo le camello'],
    honk: ['¡Pite pues!', '¡Muévase, señor!', '¡Ay, qué trancón!', '¿Sí o qué?', '¡Uy, qué tal este!', '¡Pilas, pues!'],
    welcome: 'La capital: frío, trancón y oportunidades. ¡A camellar!',
    landmark: { kind: 'monserrate', x: MW + 4, y: 70 },
  },
  medellin: {
    id: 'medellin', name: 'Medellín', nick: 'La Eterna Primavera', seed: 5021,
    districts: {
      T: { name: 'Comuna 13', rep: 0, color: '#e57373', tagline: 'Grafitis, escaleras eléctricas y puro arte.' },
      L: { name: 'Laureles', rep: 0, color: '#8bc34a', tagline: 'Arborizado, tranquilo y con buena papa.' },
      C: { name: 'Centro', rep: 0, color: '#b0a8a0', tagline: 'Botero, el Parque Berrío y el metro pasando.' },
      P: { name: 'El Poblado', rep: 0, color: '#ab47bc', tagline: 'Vidrio, Provenza y el Parque Lleras.' },
      B: { name: 'Belén', rep: 0, color: '#ffb74d', tagline: 'Arepa, fútbol en la cuadra y señoras en la ventana.' },
      E: { name: 'Envigado', rep: 0, color: '#4db6ac', tagline: 'El pueblito sabroso pegado a la ciudad.' },
      N: { name: 'Manrique', rep: 0, color: '#f06292', tagline: 'Las lomas, el metrocable y el tango.' },
      A: { name: 'Aeropuerto Olaya Herrera', rep: 0, color: '#9fb4c8', tagline: 'Avionetas, turistas y montañas.' },
    },
    grid: ['TTTLLCCCNN', 'TTTLLCCCNN', 'AATLLCCCNN', 'AALLLCCPPN', 'AABBBPPPPP', 'AABBBPPPPP', 'BBBBEEEPPP', 'BBBBEEEEEE'],
    style: { T: KIT.comuna, L: withK(KIT.brick, { empty: 0.1 }), C: withK(KIT.centro, { walls: ['#a0522d', '#8d6e63', '#6d4c41'] }), P: KIT.glass, B: withK(KIT.barrio, { roofs: ['#b5523b', '#a65d3f', '#c46a3c'] }), E: KIT.colonial, N: KIT.comuna },
    parks: {
      '6,1': { kind: 'botero', name: 'Plaza Botero' }, '6,2': { kind: 'plaza', name: 'Parque Berrío' },
      '7,4': { kind: 'park93', name: 'Parque Lleras' }, '3,3': { kind: 'park', name: 'Parque de Laureles' },
      '5,7': { kind: 'park', name: 'Parque de Envigado' }, '8,0': { kind: 'park', name: 'Entrada al Parque Arví' },
      '1,0': { kind: 'park', name: 'Mirador de la Comuna 13' },
    },
    avH: 'Av. San Juan', avV: 'Av. Oriental',
    troncal: { name: 'Metroplús', short: 'M+', color: '#2e7d32', lane: '#2f5d34', fare: 2900 },
    stationNames: ['San Javier', 'Floresta', 'Industriales', 'Poblado', 'Exposiciones', 'Parque Berrío', 'Prado', 'Niquía'],
    airport: 'Olaya Herrera', climate: 'templado', rain: 0.25, palms: false,
    outside: { N: 'mount', S: 'mount', W: 'mount', E: 'mount' },
    metro: true, radio: 0, price: 280000,
    sayings: ['¡Eh, avemaría, pues!', '¿Qué más pues, parcero?', 'Hágale pues, mijo', '¡Qué chimba de día!', 'Pa\' las que sea, pues', '¡Ome, no sea tan lambón!', 'Bien o qué, ¿todo bien?', 'Eso sí está muy bacano', 'Vamos por una bandeja, pues', '¡Pilas pues con el metro!', 'Medallo es Medallo, parce', 'De una, ¡hagámosle!', '¡Qué gonorrea de calor! Mentiras, aquí es primavera', '¿Y vos qué, pues?'],
    honk: ['¡Avemaría, avance pues!', '¡Ome, muévase!', '¡Hágale, que voy de afán!'],
    welcome: 'La ciudad de la eterna primavera 🌸 Metro, flores y bandeja paisa.',
    hotel: 'P', food: [['fonda', 'C'], ['fonda', 'B'], ['cafepaisa', 'L'], ['cafepaisa', 'P']], misc: ['L', 'C', 'C', 'B', 'B', 'T'],
    ropa: ['paisa_ropa', 'C'], club: ['P', 'Discoteca Provenza'], hides: ['T', 'N', 'B'],
    markets: [['hueco', 'C'], ['minorista', 'C'], ['lleras', 'P']],
    givers: [
      { id: 'g_domi', mission: 'delivery', d: 'L', npc: 'Domicilios Paisas' },
      { id: 'g_hustle', mission: 'hustle', d: 'C', npc: 'Doña Gilma' },
      { id: 'g_taxi', mission: 'taxi', d: 'B', npc: 'Don Efraín, taxista' },
      { id: 'g_race', mission: 'carrera', d: 'P', npc: 'Los de las Palmas' },
      { id: 'g_gang', mission: 'pandilla', d: 'B', npc: 'La Junta de Belén' },
      { id: 'g_silleta', mission: 'silleta', d: 'E', npc: 'Don Arturo, silletero' },
      { id: 'g_grafiti', mission: 'grafiti', d: 'T', npc: 'Guía de la Comuna 13' },
    ],
    landmark: { kind: 'cable', x: MW + 3, y: 20 },
  },
  cali: {
    id: 'cali', name: 'Cali', nick: 'La Sucursal del Cielo', seed: 7311,
    districts: {
      G: { name: 'Granada', rep: 0, color: '#ba68c8', tagline: 'Restaurantes, rumba y la Avenida Sexta.' },
      N: { name: 'San Antonio', rep: 0, color: '#ffb74d', tagline: 'Colinas coloniales y los mejores atardeceres.' },
      C: { name: 'Centro', rep: 0, color: '#a1a1a1', tagline: 'La Plaza de Caycedo y el Bulevar del Río.' },
      J: { name: 'Juanchito', rep: 0, color: '#ef5350', tagline: 'Aquí se baila salsa hasta que salga el sol.' },
      E: { name: 'El Peñón', rep: 0, color: '#4db6ac', tagline: 'El Gato del Río y la brisa de la tarde.' },
      P: { name: 'Pance', rep: 0, color: '#81c784', tagline: 'Verde, ríos fríos y paseo de olla.' },
      A: { name: 'Aeropuerto Bonilla Aragón', rep: 0, color: '#9fb4c8', tagline: 'Calorcito apenas se abre la puerta.' },
    },
    grid: ['GGGGCCJJJJ', 'GGGNCCJJJJ', 'AANNCCCJJJ', 'AANNECCCJJ', 'AAEEECCCJJ', 'AAEEEPPPJJ', 'PPPPPPPPJJ', 'PPPPPPPPPJ'],
    style: { G: withK(KIT.brick, { kind: 'glass', roofs: KIT.glass.roofs }), N: KIT.colonial, C: KIT.centro, J: withK(KIT.costa, { graffiti: true }), E: KIT.brick, P: withK(KIT.verde, { empty: 0.14 }) },
    parks: {
      '5,3': { kind: 'rio', name: 'Bulevar del Río' }, '3,2': { kind: 'plaza', name: 'Iglesia de San Antonio' },
      '4,4': { kind: 'gato', name: 'El Gato del Río' }, '7,1': { kind: 'park', name: 'Parque de la Salsa' },
      '3,7': { kind: 'park', name: 'Parque de la Caña' }, '1,0': { kind: 'park93', name: 'Parque del Perro' },
    },
    avH: 'Calle Quinta', avV: 'Av. Sexta',
    troncal: { name: 'MIO', short: 'MIO', color: '#1565c0', lane: '#1e3f73', fare: 2700 },
    stationNames: ['Universidades', 'Calipso', 'Santa Librada', 'Plaza de Caycedo', 'Estadio', 'Torre de Cali', 'Chiminangos', 'Menga'],
    airport: 'Bonilla Aragón', climate: 'calor', rain: 0.2, palms: true,
    outside: { N: 'cana', S: 'cana', W: 'mount', E: 'cana' },
    radio: 2, price: 260000,
    sayings: ['¡Oís, ve, qué más pues!', '¡Mirá ve, qué calor tan berraco!', '¿Vos qué, mor?', 'Cali es Cali, lo demás es loma', '¡Uy, qué chimba de salsa!', 'Ve, ¿y vos de dónde sos?', '¡Ay, no, qué pereza!', 'Pasáme el chontaduro, ve', 'Esta noche es pa\' bailar, mi llave', '¡Ve, qué ricura de brisa!', 'Ole, ¿qué más pues, pelao?', '¡Ahí sí, mor, a gozar!'],
    honk: ['¡Mirá ve, avanzá pues!', '¡Oís, moveté!', '¡Ve, qué man tan lento!'],
    welcome: 'La capital mundial de la salsa 💃 Chontaduro, brisa y rumba hasta el amanecer.',
    hotel: 'G', food: [['chontaduro', 'C'], ['chontaduro', 'J'], ['pandebono', 'N'], ['sancocho', 'E']], misc: ['G', 'C', 'C', 'E', 'J', 'J'],
    ropa: ['salsero', 'G'], club: ['J', 'Juanchito Salsa Club'], hides: ['J', 'P', 'E'],
    markets: [['alameda', 'C'], ['santaelena', 'J'], ['granada', 'G']],
    givers: [
      { id: 'g_domi', mission: 'delivery', d: 'E', npc: 'Domicilios Caleños' },
      { id: 'g_hustle', mission: 'hustle', d: 'C', npc: 'Doña Mercedes' },
      { id: 'g_taxi', mission: 'taxi', d: 'C', npc: 'Taxista Caleño' },
      { id: 'g_race', mission: 'carrera', d: 'P', npc: 'Los Pilotos de Pance' },
      { id: 'g_gang', mission: 'pandilla', d: 'J', npc: 'Líder de Juanchito' },
      { id: 'g_salsa', mission: 'salsa', d: 'J', npc: 'Jurado del Concurso' },
      { id: 'g_vend', mission: 'vendedor', d: 'C', npc: 'Don Chucho', product: { n: 'chontaduro', icon: '🥥', pay: 12000 } },
    ],
    landmark: { kind: 'cristo', x: -5, y: 60 },
  },
  cartagena: {
    id: 'cartagena', name: 'Cartagena', nick: 'La Heroica', seed: 9177,
    districts: {
      M: { name: 'Ciudad Amurallada', rep: 0, color: '#f2c94c', tagline: 'Balcones, buganvilias y coches de caballos.' },
      G: { name: 'Getsemaní', rep: 0, color: '#e86a92', tagline: 'Grafitis, sombrillas de colores y rumba en la plaza.' },
      B: { name: 'Bocagrande', rep: 0, color: '#4fc3f7', tagline: 'Torres blancas, playa y sol picante.' },
      Z: { name: 'Manga', rep: 0, color: '#9ccc65', tagline: 'Casas republicanas y la brisa de la bahía.' },
      K: { name: 'Bazurto', rep: 0, color: '#ff8a65', tagline: 'El mercado más caótico y sabroso del Caribe.' },
      A: { name: 'Aeropuerto Rafael Núñez', rep: 0, color: '#9fb4c8', tagline: 'Sales del avión y te abraza el calor.' },
    },
    grid: ['MMMMGGGZZZ', 'MMMMGGGZZZ', 'AAMMGGGZZZ', 'AABBGGZZKK', 'AABBBZZKKK', 'AABBBZZKKK', 'BBBBBZZKKK', 'BBBBBZZKKK'],
    style: { M: KIT.colonial, G: withK(KIT.colonial, { graffiti: true, balcony: false }), B: KIT.white, Z: KIT.costa, K: withK(KIT.costa, { minS: 2, empty: 0.04 }) },
    parks: {
      '0,0': { kind: 'muralla', name: 'Baluarte de Santo Domingo' }, '1,0': { kind: 'muralla', name: 'Las Murallas' },
      '0,1': { kind: 'muralla', name: 'Baluarte de San Ignacio' }, '3,1': { kind: 'reloj', name: 'Torre del Reloj' },
      '2,0': { kind: 'plaza', name: 'Plaza de la Catedral' }, '5,1': { kind: 'usaquen', name: 'Plaza de la Trinidad' },
      '8,1': { kind: 'castillo', name: 'Castillo San Felipe' }, '0,6': { kind: 'beach', name: 'Playa de Bocagrande' },
      '0,7': { kind: 'beach', name: 'Playa de Castillogrande' }, '1,7': { kind: 'beach', name: 'Playa del Laguito' },
      '8,5': { kind: 'usaquen', name: 'Mercado de Bazurto' },
    },
    avH: 'Av. Pedro de Heredia', avV: 'Av. Santander',
    troncal: { name: 'Transcaribe', short: 'TC', color: '#00897b', lane: '#1f5e57', fare: 2900 },
    stationNames: ['Portal El Gallo', 'Bazurto', 'Chambacú', 'La Popa', 'Bocagrande', 'Centro', 'Getsemaní', 'Crespo'],
    airport: 'Rafael Núñez', climate: 'calor', rain: 0.1, palms: true,
    outside: { N: 'sea', S: 'sea', W: 'sea', E: 'manglar' },
    radio: 3, price: 420000,
    sayings: ['¡Ajá, y entonces!', '¡Eche, no joda, qué calor!', '¿Qué hubo, mi llave?', '¡Ombe, qué vaina tan buena!', '¡Erda, mi vale!', 'Aquí se vive sabroso, compa', '¡Uy, cuidao con el sol, cachaco!', '¡Ajá, mi rey, a la orden!', '¡Ey, mi vale, cómprame una cocadita!', 'Eso está bacano, ¿oíste?', 'Tranquilo, que aquí todo es con calma', '¡Qué molleja de calor!', '¿Masajito, mi amor? Barato'],
    honk: ['¡Eche, muévete, mi vale!', '¡Ajá, y qué esperas!', '¡Ombe, avanza!'],
    welcome: 'La Heroica 🌴 Murallas, playa y un calor que no perdona.',
    hotel: 'M', food: [['fritos', 'M'], ['mariscos', 'B'], ['raspao', 'G'], ['cocadas', 'B']], misc: ['G', 'Z', 'M', 'K', 'K', 'K'],
    ropa: ['costa_ropa', 'M'], club: ['G', 'Champetódromo La Trinidad'], hides: ['G', 'K', 'Z'],
    markets: [['bazurto', 'K'], ['amurallada', 'M'], ['bocagrande', 'B']],
    givers: [
      { id: 'g_domi', mission: 'delivery', d: 'Z', npc: 'Domicilios del Caribe' },
      { id: 'g_hustle', mission: 'hustle', d: 'K', npc: 'Doña Emelina' },
      { id: 'g_taxi', mission: 'taxi', d: 'Z', npc: 'Los del Mototaxi' },
      { id: 'g_race', mission: 'carrera', d: 'B', npc: 'Los Pelaos del Laguito' },
      { id: 'g_gang', mission: 'pandilla', d: 'K', npc: 'Comerciantes de Bazurto' },
      { id: 'g_guia', mission: 'guia', d: 'M', npc: 'Agencia de Turismo' },
      { id: 'g_vend', mission: 'vendedor', d: 'B', npc: 'Palenquera Doña Emelina', product: { n: 'cocadas', icon: '🥥', pay: 14000 } },
    ],
    landmark: { kind: 'popa', x: MW + 5, y: 30 },
  },
  barranquilla: {
    id: 'barranquilla', name: 'Barranquilla', nick: 'Curramba la Bella', seed: 3343,
    districts: {
      N: { name: 'Norte', rep: 0, color: '#7986cb', tagline: 'Edificios, centros comerciales y la Calle 84.' },
      P: { name: 'El Prado', rep: 0, color: '#aed581', tagline: 'Casonas republicanas y palmeras.' },
      R: { name: 'Barrio Abajo', rep: 0, color: '#ff7043', tagline: 'Cuna del Carnaval: tambores y marimondas.' },
      C: { name: 'Centro', rep: 0, color: '#bdbdbd', tagline: 'El Paseo Bolívar y los almacenes.' },
      S: { name: 'Soledad', rep: 0, color: '#ffd54f', tagline: 'Calor, picó y fritos por todo lado.' },
      M: { name: 'Gran Malecón', rep: 0, color: '#4dd0e1', tagline: 'El río Magdalena y la brisa de la tarde.' },
      A: { name: 'Aeropuerto Cortissoz', rep: 0, color: '#9fb4c8', tagline: '¡Bienvenido a Curramba, mi llave!' },
    },
    grid: ['NNNNNPPPMM', 'NNNNNPPPMM', 'AANNPPPRMM', 'AARRPPPRRM', 'AARRRCCCRM', 'AASSRCCCCM', 'SSSSSCCCCM', 'SSSSSSCCCM'],
    style: { N: KIT.white, P: withK(KIT.colonial, { walls: ['#fff1c1', '#f6d6a8', '#e8f5e9', '#ffe0b2', '#f8bbd0'] }), R: withK(KIT.costa, { graffiti: true }), C: KIT.centro, S: KIT.costa, M: KIT.costa },
    parks: {
      '8,0': { kind: 'malecon', name: 'Gran Malecón' }, '9,0': { kind: 'malecon', name: 'Gran Malecón' }, '8,1': { kind: 'malecon', name: 'Gran Malecón' },
      '9,1': { kind: 'malecon', name: 'Gran Malecón' }, '9,2': { kind: 'malecon', name: 'Gran Malecón' }, '9,3': { kind: 'malecon', name: 'Gran Malecón' },
      '9,4': { kind: 'malecon', name: 'Gran Malecón' }, '9,5': { kind: 'malecon', name: 'Gran Malecón' }, '9,6': { kind: 'malecon', name: 'Gran Malecón' },
      '9,7': { kind: 'malecon', name: 'Gran Malecón' }, '8,2': { kind: 'malecon', name: 'Gran Malecón' },
      '6,1': { kind: 'park93', name: 'Parque Washington' }, '5,4': { kind: 'plaza', name: 'Plaza de la Paz' },
      '3,3': { kind: 'usaquen', name: 'Plaza del Carnaval' }, '2,6': { kind: 'park', name: 'Parque de Soledad' },
    },
    avH: 'Calle Murillo', avV: 'Av. Olaya Herrera',
    troncal: { name: 'Transmetro', short: 'TRM', color: '#43a047', lane: '#2f5a32', fare: 2650 },
    stationNames: ['Portal de Soledad', 'Joaquín Barrios', 'Barranquillita', 'Paseo Bolívar', 'Hospital', 'Plaza de la Paz', 'Calle 72', 'Portal del Norte'],
    airport: 'Ernesto Cortissoz', climate: 'calor', rain: 0.15, palms: true,
    outside: { N: 'sea', S: 'sabana', W: 'sabana', E: 'river' },
    radio: 3, price: 380000,
    sayings: ['¡Ajá, mi llave! ¿Qué es la que hay?', '¡Quien lo vive es quien lo goza!', '¡Nojoda, qué brisa tan sabrosa!', '¡Eche, no joda!', 'Ajá, ¿y la mía qué?', '¡Erda, qué calor tan arrecho!', 'Mi vale, vamos pa\' la verbena', '¡Ombe, eso está bueno!', 'Aquí en Curramba todo es bacano', '¡Ey, mi llave, sube el picó!', 'Ajá, ¿te vas a disfrazá pa\'l Carnaval?', '¡Qué vaina tan buena, compa!'],
    honk: ['¡Ajá, avanza, mi llave!', '¡Eche, el pito no es de adorno!', '¡Nojoda, muévete!'],
    welcome: 'Curramba la Bella 🎭 ¡Quien lo vive es quien lo goza!',
    hotel: 'N', food: [['fritos', 'C'], ['sancocho', 'S'], ['raspao', 'P'], ['fritos', 'R']], misc: ['N', 'P', 'C', 'S', 'S', 'R'],
    ropa: ['carnaval_ropa', 'R'], club: ['N', 'La Troja del Picó'], hides: ['R', 'S', 'C'],
    markets: [['barranquillita', 'C'], ['paseo', 'C'], ['calle84', 'N']],
    givers: [
      { id: 'g_domi', mission: 'delivery', d: 'P', npc: 'Domicilios Curramba' },
      { id: 'g_hustle', mission: 'hustle', d: 'C', npc: 'Don Abelardo' },
      { id: 'g_taxi', mission: 'taxi', d: 'S', npc: 'Mototaxista de Soledad' },
      { id: 'g_race', mission: 'carrera', d: 'N', npc: 'Los Pelaos de la 84' },
      { id: 'g_gang', mission: 'pandilla', d: 'S', npc: 'La Cuadra de Soledad' },
      { id: 'g_carnaval', mission: 'carnaval', d: 'R', npc: 'Reina del Carnaval' },
      { id: 'g_vend', mission: 'vendedor', d: 'S', npc: 'Doña Nena', product: { n: 'bollos de yuca', icon: '🌽', pay: 11000 } },
    ],
    landmark: null,
  },
};
const CITY_ORDER = ['bogota', 'medellin']; // Cali, Cartagena y Barranquilla ya tienen datos; se activan después
let CITY = CITIES.bogota;
let DISTRICTS, DISTRICT_GRID, STYLE, PARKS, POI_DEFS;
/** Activa una ciudad: todas las funciones del mundo leen estas variables. */
function applyCity(id) {
  CITY = CITIES[id] || CITIES.bogota;
  DISTRICTS = CITY.districts; DISTRICT_GRID = CITY.grid; STYLE = CITY.style; PARKS = CITY.parks;
  POI_DEFS = CITY.id === 'bogota' ? CITY.pois : cityPOIs(CITY);
}
applyCity('bogota');

// --- Tiendas, mercados y vivienda de las otras ciudades ---
HOMES.hotel = { name: 'Hotel', price: 0, rent: 0, sleep: 90, night: 70000 };
Object.assign(SHOPS, {
  fonda: { name: 'Fonda Paisa La Arriería', icon: '🍛', color: '#ff7043', items: [
    { n: 'Bandeja paisa', p: 32000, e: 100, h: 20 }, { n: 'Arepa con quesito', p: 4000, e: 18 }, { n: 'Mazamorra con panela', p: 3500, e: 14, h: 3 }] },
  cafepaisa: { name: 'Café de la 70', icon: '☕', color: '#8d6e63', items: [
    { n: 'Tinto campesino', p: 2000, e: 10 }, { n: 'Buñuelo', p: 1500, e: 8 }, { n: 'Parva paisa', p: 5000, e: 20 }] },
  paisa_ropa: { name: 'Almacén El Carriel', icon: '👜', color: '#a1887f', items: [
    { n: 'Carriel antioqueño', p: 150000, cloth: 'carriel', rep: 5, desc: 'Más paisa que la arepa: +5 reputación.' },
    { n: 'Poncho', p: 70000, cloth: 'ruana', rep: 2, desc: 'Abriga en las lomas y en la lluvia.' },
    { n: 'Sombrero aguadeño', p: 90000, cloth: 'sombrero', rep: 3, desc: 'El sol y el calor ya no te cansan.' }] },
  chontaduro: { name: 'Chontaduro y Cholado', icon: '🥥', color: '#ff9800', items: [
    { n: 'Chontaduro con sal y miel', p: 3000, e: 16 }, { n: 'Cholado', p: 7000, e: 28, cool: true }, { n: 'Lulada', p: 5000, e: 18, cool: true }] },
  pandebono: { name: 'Pandebonos del Valle', icon: '🥯', color: '#ffca28', items: [
    { n: 'Pandebono', p: 1500, e: 10 }, { n: 'Champús', p: 3500, e: 14, cool: true }, { n: 'Empanada valluna', p: 1500, e: 9 }] },
  sancocho: { name: 'Sancochos Doña Nena', icon: '🍲', color: '#fdd835', items: [
    { n: 'Sancocho', p: 18000, e: 80, h: 15 }, { n: 'Bollo de yuca', p: 1500, e: 10 }, { n: 'Jugo de níspero', p: 5000, e: 16, cool: true }] },
  fritos: { name: 'Fritos de Doña Eloísa', icon: '🫓', color: '#ffb300', items: [
    { n: 'Arepa e\' huevo', p: 4000, e: 20 }, { n: 'Carimañola', p: 2500, e: 12 }, { n: 'Butifarra', p: 3000, e: 14 }] },
  mariscos: { name: 'La Mojarra de Bocagrande', icon: '🐟', color: '#26c6da', items: [
    { n: 'Mojarra frita con patacón', p: 35000, e: 85, h: 15 }, { n: 'Cazuela de mariscos', p: 45000, e: 100, h: 20 }, { n: 'Limonada de coco', p: 9000, e: 20, cool: true }] },
  raspao: { name: 'Raspao y Bolis', icon: '🍧', color: '#f06292', items: [
    { n: 'Raspao de colores', p: 2500, e: 8, cool: true }, { n: 'Bolis de corozo', p: 1000, e: 5, cool: true }, { n: 'Agua de coco', p: 4000, e: 12, h: 3, cool: true }] },
  cocadas: { name: 'Palenquera Doña Emelina', icon: '🥥', color: '#8bc34a', items: [
    { n: 'Cocadas', p: 3000, e: 14 }, { n: 'Alegría de coco', p: 2000, e: 10 }, { n: 'Enyucado', p: 3000, e: 15 }] },
  costa_ropa: { name: 'Artesanías del Caribe', icon: '👒', color: '#ffb74d', items: [
    { n: 'Sombrero vueltiao', p: 150000, cloth: 'sombrero', rep: 4, desc: 'El calor ya no te cansa. ¡Puro orgullo costeño!' },
    { n: 'Guayabera', p: 110000, cloth: 'guayabera', rep: 3, desc: 'Elegante y fresquita.' },
    { n: 'Chanclas', p: 25000, cloth: 'tenis', rep: 0, desc: 'Corres más (sí, con chanclas).' }] },
  salsero: { name: 'Pinta Salsera', icon: '🕺', color: '#e91e63', items: [
    { n: 'Camisa de salsero', p: 120000, cloth: 'salsero', rep: 4, desc: 'Más margen en el concurso de salsa.' },
    { n: 'Zapatos de baile', p: 90000, cloth: 'tenis', rep: 2, desc: 'Corres 12% más rápido.' }] },
  carnaval_ropa: { name: 'Disfraces del Carnaval', icon: '🎭', color: '#ffeb3b', items: [
    { n: 'Máscara de marimonda', p: 80000, cloth: 'marimonda', rep: 5, desc: '¡Quien lo vive es quien lo goza!' },
    { n: 'Sombrero vueltiao', p: 150000, cloth: 'sombrero', rep: 4, desc: 'El calor ya no te cansa.' }] },
  armas: { name: 'Los Fierros del Mono', icon: '🔫', color: '#78909c', items: [
    { n: 'Bate de béisbol', p: 45000, weapon: 'bate', desc: 'Para defenderse en la cuadra.' },
    { n: 'Pistola', p: 380000, weapon: 'pistola', desc: 'Incluye 24 tiros.' },
    { n: 'Munición de pistola ×24', p: 30000, ammo: 'pistola', amount: 24 },
    { n: 'Escopeta', p: 950000, weapon: 'escopeta', desc: 'Pega duro de cerca. Incluye 12 cartuchos.' },
    { n: 'Cartuchos ×12', p: 45000, ammo: 'escopeta', amount: 12 },
    { n: 'Mini-Uzi', p: 1700000, weapon: 'uzi', desc: 'Dispara ráfagas. Incluye 60 tiros.' },
    { n: 'Munición Uzi ×60', p: 60000, ammo: 'uzi', amount: 60 },
    { n: 'Papas bomba ×3', p: 15000, ammo: 'papa', amount: 3, desc: 'Se tiran y ¡PUM! Ojo dónde caen.' }] },
});
Object.assign(MARKETS, {
  hueco: { name: 'El Hueco', desc: 'El paraíso del contrabando… digo, de lo barato.', m: { paraguas: 0.55, mango: 0.9, cargador: 0.5, ropa: 0.45, flores: 0.7, cafe: 0.8, artesania: 0.85 } },
  minorista: { name: 'Plaza Minorista', desc: 'Fruta y flores fresquitas.', m: { paraguas: 0.9, mango: 0.5, cargador: 1.0, ropa: 0.9, flores: 0.4, cafe: 0.6, artesania: 1.0 } },
  lleras: { name: 'Puestos del Parque Lleras', desc: 'Turistas con dólares.', m: { paraguas: 1.4, mango: 1.4, cargador: 1.5, ropa: 1.3, flores: 1.5, cafe: 1.6, artesania: 1.6 } },
  alameda: { name: 'Galería Alameda', desc: 'La galería más sabrosa de Cali.', m: { paraguas: 0.9, mango: 0.45, cargador: 0.9, ropa: 0.8, flores: 0.9, cafe: 0.75, artesania: 0.9 } },
  santaelena: { name: 'Galería Santa Elena', desc: 'Al por mayor y con regateo.', m: { paraguas: 0.7, mango: 0.6, cargador: 0.65, ropa: 0.6, flores: 0.85, cafe: 0.8, artesania: 0.95 } },
  granada: { name: 'Toldos de Granada', desc: 'Gente con plata en la Sexta.', m: { paraguas: 1.3, mango: 1.5, cargador: 1.4, ropa: 1.5, flores: 1.6, cafe: 1.4, artesania: 1.5 } },
  bazurto: { name: 'Mercado de Bazurto', desc: 'Caos total, precios bajitos.', m: { paraguas: 0.6, mango: 0.4, cargador: 0.6, ropa: 0.55, flores: 1.1, cafe: 0.9, artesania: 0.6 } },
  amurallada: { name: 'Toldos de la Ciudad Amurallada', desc: 'Cruceros llenos de turistas.', m: { paraguas: 1.6, mango: 1.6, cargador: 1.4, ropa: 1.5, flores: 1.8, cafe: 1.9, artesania: 2.0 } },
  bocagrande: { name: 'Vendedores de Bocagrande', desc: 'En la playa todo vale doble.', m: { paraguas: 1.9, mango: 1.5, cargador: 1.3, ropa: 1.3, flores: 1.3, cafe: 1.4, artesania: 1.6 } },
  barranquillita: { name: 'Mercado de Barranquillita', desc: 'Donde se surte media costa.', m: { paraguas: 0.6, mango: 0.45, cargador: 0.6, ropa: 0.55, flores: 1.0, cafe: 0.85, artesania: 0.75 } },
  paseo: { name: 'Paseo Bolívar', desc: 'Vendedores por todo lado.', m: { paraguas: 0.9, mango: 0.9, cargador: 0.8, ropa: 0.8, flores: 1.1, cafe: 1.0, artesania: 1.0 } },
  calle84: { name: 'Puestos de la 84', desc: 'La zona rosa de Curramba.', m: { paraguas: 1.6, mango: 1.4, cargador: 1.5, ropa: 1.4, flores: 1.7, cafe: 1.5, artesania: 1.5 } },
});
Object.assign(MISSION_INFO, {
  taxi: { title: 'Taxista Pirata', icon: '🚕', rep: 5, color: '#ffd21f', desc: 'Recoge pasajeros y llévalos rápido. Necesitas carro o moto (en la costa, ¡mototaxi!).' },
  carrera: { title: 'Pique Ilegal', icon: '🏁', rep: 10, color: '#ff9100', desc: 'Carrera callejera contra dos pilotos. Pasa por todos los puntos antes que ellos. Necesitas vehículo.' },
  pandilla: { title: 'Guerra de Pandillas', icon: '👊', rep: 8, color: '#d50000', desc: 'Una gallada se tomó un parque y tiene azotado al barrio. Noquéalos a todos. Mejor llega armado (Los Fierros del Mono 🔫).' },
  silleta: { title: 'Desfile de Silleteros', icon: '💐', rep: 0, color: '#f06292', desc: 'Lleva la silleta llena de flores hasta la tarima del desfile. Pesa harto: no puedes correr ni montarte en nada.' },
  grafiti: { title: 'Grafitour Comuna 13', icon: '🎨', rep: 0, color: '#ff7043', desc: 'Lleva a los turistas a ver los 4 murales más bacanos de la Comuna 13 antes de que se les acabe la batería del celular.' },
  salsa: { title: 'Concurso de Salsa', icon: '💃', rep: 0, color: '#e91e63', desc: 'Sube a la pista y demostrá que sos un salsero caleño. Seguí el ritmo con las flechas (o los botones).' },
  vendedor: { title: 'Venta Ambulante', icon: '🛒', rep: 0, color: '#8bc34a', desc: 'Sal con el carrito y vende en todos los puntos antes de que se acabe el turno.' },
  guia: { title: 'Guía Turístico', icon: '📸', rep: 0, color: '#26c6da', desc: 'Los turistas quieren conocer lo más bacano de La Heroica. Llévalos a los 3 sitios antes de que se acabe el tour.' },
  carnaval: { title: 'Batalla de Flores', icon: '🎭', rep: 0, color: '#ffeb3b', desc: 'Métete al desfile del Carnaval y recoge 10 bolsas de maicena antes de que pase la última carroza.' },
});
Object.assign(ACH, {
  viajero: { n: 'Mochilero', d: 'Visita las 5 ciudades.', i: '✈️' },
  salsero: { n: 'Salsero caleño', d: 'Gana el concurso de salsa.', i: '💃' },
  carnaval: { n: 'Quien lo vive lo goza', d: 'Termina la Batalla de Flores.', i: '🎭' },
  silletero: { n: 'Silletero', d: 'Lleva la silleta al desfile.', i: '💐' },
  piloto: { n: 'Rey del pique', d: 'Gana una carrera ilegal.', i: '🏁' },
  barrio: { n: 'Defensor del barrio', d: 'Gana una guerra de pandillas.', i: '👊' },
  bandeja: { n: 'Paisa de corazón', d: 'Cómete una bandeja paisa.', i: '🍛' },
});

/** Armas: daño, cadencia (s), velocidad de la bala, dispersión. */
const WEAPONS = {
  punos: { n: 'Puños', icon: '👊', melee: true, dmg: 12, range: 20, rate: 0.42 },
  bate: { n: 'Bate', icon: '🏏', melee: true, dmg: 30, range: 27, rate: 0.6 },
  pistola: { n: 'Pistola', icon: '🔫', dmg: 24, rate: 0.3, speed: 950, spread: 0.04, range: 560, start: 24 },
  escopeta: { n: 'Escopeta', icon: '💥', dmg: 14, pellets: 6, rate: 0.85, speed: 820, spread: 0.24, range: 320, start: 12 },
  uzi: { n: 'Mini-Uzi', icon: '🔥', dmg: 13, rate: 0.085, speed: 980, spread: 0.11, range: 480, start: 60 },
  papa: { n: 'Papa bomba', icon: '💣', thrown: true, dmg: 75, radius: 78, rate: 0.8, range: 260 },
};
const WEAPON_ORDER = ['punos', 'bate', 'pistola', 'escopeta', 'uzi', 'papa'];

/** Emisoras de radio (todo sintetizado, nada de canciones con derechos). */
const STATIONS = [
  { id: 'mega', name: 'La Mega 🔥 Reguetón', bpm: 94 },
  { id: 'tropi', name: 'Tropicana · Cumbia', bpm: 100 },
  { id: 'rumba', name: 'Rumba Estéreo · Salsa', bpm: 104 },
  { id: 'champe', name: 'Champeta FM', bpm: 112 },
];
const WASTED_LINES = ['¡PAILA, PARCE!', '¡QUEDASTE FRITO!', '¡SE LO LLEVÓ EL QUE LO TRAJO!', '¡NO DIO PA\' MÁS!'];
const BUSTED_LINES = ['¡TE COGIÓ LA TOMBA!', '¡PA\' LA UPJ, MIJO!', '¡SE ACABÓ LA FIESTA!'];
const SNITCH_LINES = ['🐸 Un sapo llamó a la tomba', '🐸 ¡Lo sapearon!', '🐸 Una señora llamó al 123'];

// ==========================================================================
// 3. AUDIO — todo sintetizado con WebAudio (no hay archivos de sonido)
// ==========================================================================
const Sound = {
  ctx: null, master: null, muted: false, noiseBuf: null,
  engine: null, siren: null, rain: null,
  radio: { on: true, station: 0, forced: null, playing: false, next: 0, step: 0 },

  /** El navegador exige un gesto del usuario antes de arrancar el audio. */
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    const c = this.ctx;
    this.master = c.createGain(); this.master.gain.value = this.muted ? 0 : 0.55; this.master.connect(c.destination);
    // Ruido blanco reutilizable
    const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    // Motor: diente de sierra filtrado
    const eo = c.createOscillator(); eo.type = 'sawtooth'; eo.frequency.value = 40;
    const ef = c.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = 380;
    const eg = c.createGain(); eg.gain.value = 0;
    eo.connect(ef); ef.connect(eg); eg.connect(this.master); eo.start();
    this.engine = { o: eo, f: ef, g: eg };
    // Sirena de policía
    const so = c.createOscillator(); so.type = 'square'; so.frequency.value = 700;
    const sf = c.createBiquadFilter(); sf.type = 'lowpass'; sf.frequency.value = 1800;
    const sg = c.createGain(); sg.gain.value = 0;
    so.connect(sf); sf.connect(sg); sg.connect(this.master); so.start();
    this.siren = { o: so, g: sg };
    // Lluvia: ruido pasabanda en bucle
    const rn = c.createBufferSource(); rn.buffer = buf; rn.loop = true;
    const rf = c.createBiquadFilter(); rf.type = 'bandpass'; rf.frequency.value = 1500; rf.Q.value = 0.5;
    const rg = c.createGain(); rg.gain.value = 0;
    rn.connect(rf); rf.connect(rg); rg.connect(this.master); rn.start();
    this.rain = { g: rg };
    // Bus de la radio (volumen propio)
    this.radioBus = c.createGain(); this.radioBus.gain.value = 0.9; this.radioBus.connect(this.master);
  },

  setMuted(m) { this.muted = m; if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05); },

  /** Tono simple con envolvente. */
  tone(freq, dur, type = 'sine', vol = 0.15, when = 0, slide = 0, dest) {
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t = c.currentTime + when;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || this.master); o.start(t); o.stop(t + dur + 0.05);
  },

  /** Golpe de ruido filtrado (choques, truenos, guacharaca). */
  noise(dur, vol = 0.2, freq = 800, type = 'lowpass', when = 0, dest) {
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t = c.currentTime + when;
    const s = c.createBufferSource(); s.buffer = this.noiseBuf;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(dest || this.master);
    s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
  },

  sfx(name) {
    if (!this.ctx) return;
    switch (name) {
      case 'coin': this.tone(988, 0.08, 'square', 0.08); this.tone(1319, 0.16, 'square', 0.08, 0.07); break;
      case 'buy': this.tone(660, 0.07, 'triangle', 0.15); this.tone(880, 0.12, 'triangle', 0.15, 0.06); break;
      case 'deny': this.tone(200, 0.15, 'square', 0.08); this.tone(150, 0.2, 'square', 0.08, 0.1); break;
      case 'click': this.tone(1200, 0.03, 'square', 0.04); break;
      case 'notify': this.tone(784, 0.08, 'sine', 0.12); this.tone(1047, 0.14, 'sine', 0.12, 0.08); break;
      case 'success': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.2, 'square', 0.07, i * 0.09)); break;
      case 'fail': [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.25, 'sawtooth', 0.06, i * 0.12)); break;
      case 'crash': this.noise(0.35, 0.35, 600); this.tone(90, 0.2, 'sine', 0.2, 0, -40); break;
      case 'bump': this.noise(0.12, 0.18, 400); break;
      case 'horn': this.tone(392, 0.25, 'square', 0.05); this.tone(494, 0.25, 'square', 0.05); break;
      case 'door': this.noise(0.08, 0.15, 1200, 'bandpass'); break;
      case 'star': this.tone(880, 0.12, 'square', 0.07); this.tone(660, 0.18, 'square', 0.07, 0.12); break;
      case 'thunder': this.noise(1.6, 0.4, 180); break;
      case 'splash': this.noise(0.2, 0.08, 2500, 'highpass'); break;
      case 'shot': this.noise(0.09, 0.3, 2400, 'highpass'); this.tone(140, 0.08, 'square', 0.08, 0, -60); break;
      case 'shotgun': this.noise(0.25, 0.4, 900); this.tone(90, 0.15, 'square', 0.12, 0, -40); break;
      case 'uzi': this.noise(0.05, 0.2, 2800, 'highpass'); break;
      case 'boom': this.noise(1.2, 0.55, 220); this.tone(55, 0.6, 'sine', 0.35, 0, -30); break;
      case 'punch': this.noise(0.08, 0.22, 500); this.tone(110, 0.06, 'sine', 0.12); break;
      case 'achievement': [659, 784, 988, 1319].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.1, i * 0.07)); break;
    }
  },

  /** Actualiza sonidos continuos según el estado del juego. */
  update(dt) {
    if (!this.ctx) return;
    const c = this.ctx, now = c.currentTime, p = G.player;
    // Motor
    const v = p && !p.onFoot ? p.vehicle : null;
    const on = G.state === 'play' && v && v.spec.engine && !v.wrecked;
    const sp = v ? Math.abs(v.speed) : 0;
    this.engine.g.gain.setTargetAtTime(on ? 0.045 + Math.min(sp / 400, 1) * 0.05 : 0, now, 0.08);
    if (on) {
      const base = v.spec.two ? 70 : 45;
      this.engine.o.frequency.setTargetAtTime(base + sp * (v.spec.two ? 0.55 : 0.32), now, 0.06);
      this.engine.f.frequency.setTargetAtTime(300 + sp * 2, now, 0.1);
    }
    // Sirena: la más cercana manda
    let near = 1e9;
    if (G.state === 'play') for (const cv of G.vehicles) if (cv.siren) near = Math.min(near, dist(cv.x, cv.y, p.x, p.y));
    const sv = near < 900 ? (1 - near / 900) * 0.05 : 0;
    this.siren.g.gain.setTargetAtTime(sv, now, 0.1);
    if (sv > 0) this.siren.o.frequency.setTargetAtTime((now * 2.2) % 1 < 0.5 ? 640 : 920, now, 0.02);
    // Lluvia
    this.rain.g.gain.setTargetAtTime(G.state === 'play' || G.state === 'title' ? G.rain * 0.16 : 0, now, 0.4);
    // Radio: suena en carro y, más pasito, a pie (audífonos)
    const forced = this.radio.forced != null;
    const wantRadio = G.state === 'play' && !G.menu && (forced || (this.radio.on && !G.overlay));
    this.radioBus.gain.setTargetAtTime(forced ? 1 : on ? 0.95 : 0.45, now, 0.2);
    if (wantRadio && !this.radio.playing) { this.radio.playing = true; this.radio.next = now + 0.05; }
    if (!wantRadio) this.radio.playing = false;
    if (this.radio.playing && !this.muted) {
      const bpm = STATIONS[forced ? this.radio.forced : this.radio.station].bpm;
      while (this.radio.next < now + 0.15) { this.stationStep(this.radio.next, this.radio.step++); this.radio.next += 60 / bpm / 4; }
    }
  },

  /** Un paso de corchea de una cumbia sencilla: guacharaca, bajo y "acordeón". */
  radioStep(t, step) {
    const c = this.ctx, w = t - c.currentTime;
    const s8 = step % 8, bar = Math.floor(step / 8) % 4;
    // guacharaca (ruido agudo con acento largo-corto-corto)
    this.noise(s8 % 2 === 0 ? 0.09 : 0.04, s8 % 4 === 0 ? 0.05 : 0.025, 5500, 'highpass', w, this.radioBus);
    // tambora en 1 y 3
    if (s8 === 0 || s8 === 4) this.tone(80, 0.18, 'sine', 0.12, w, -30, this.radioBus);
    // llamador en contratiempo
    if (s8 === 2 || s8 === 6) this.tone(220, 0.06, 'triangle', 0.05, w, 0, this.radioBus);
    // bajo: La menor / Mi mayor
    const root = [110, 82.41, 110, 82.41][bar];
    if (s8 === 0) this.tone(root, 0.3, 'triangle', 0.13, w, 0, this.radioBus);
    if (s8 === 3) this.tone(root * 1.5, 0.2, 'triangle', 0.1, w, 0, this.radioBus);
    if (s8 === 4) this.tone(root, 0.25, 'triangle', 0.12, w, 0, this.radioBus);
    if (s8 === 7) this.tone(root * 2, 0.15, 'triangle', 0.08, w, 0, this.radioBus);
    // melodía tipo acordeón
    const scale = bar % 2 === 0 ? [440, 523, 659, 587, 523, 494] : [415, 494, 659, 587, 494, 330];
    if ((step * 7919) % 11 < 6) this.tone(scale[(step * 31 + bar) % scale.length], 0.13, 'square', 0.022, w, 0, this.radioBus);
  },
};

// ==========================================================================
// 4. ENTRADA — teclado y controles táctiles
// ==========================================================================
const KEYMAP = {
  arrowup: 'up', w: 'up', arrowdown: 'down', s: 'down', arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right',
  ' ': 'space', shift: 'shift', e: 'e', f: 'f', enter: 'enter', escape: 'esc', p: 'esc', m: 'm', c: 'c', tab: 'c',
  n: 'n', r: 'r', h: 'h', x: 'x', backspace: 'back', q: 'q', control: 'fire', j: 'fire',
};
const Input = {
  keys: Object.create(null), hits: Object.create(null),
  joy: { x: 0, y: 0, on: false },
  down(...ks) { return ks.some(k => this.keys[k]); },
  hit(...ks) { return ks.some(k => this.hits[k]); },
  clear() { this.hits = Object.create(null); },
  ax() { return this.joy.on ? this.joy.x : (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0); },
  ay() { return this.joy.on ? this.joy.y : (this.keys.down ? 1 : 0) - (this.keys.up ? 1 : 0); },
};
window.addEventListener('keydown', e => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  const raw = e.key.toLowerCase();
  const k = KEYMAP[raw] || raw;
  if (['up', 'down', 'left', 'right', 'space', 'c'].includes(k)) e.preventDefault();
  if (!Input.keys[k]) Input.hits[k] = true;
  Input.keys[k] = true;
  Sound.init();
});
window.addEventListener('keyup', e => {
  const raw = e.key.toLowerCase();
  Input.keys[KEYMAP[raw] || raw] = false;
});
window.addEventListener('blur', () => { Input.keys = Object.create(null); });

/** Joystick virtual y botones para celular. */
function setupTouch() {
  const isTouch = 'ontouchstart' in window || (window.matchMedia && matchMedia('(pointer: coarse)').matches);
  const tc = document.getElementById('touch');
  if (!isTouch) return;
  tc.hidden = false;
  document.body.classList.add('touch');
  const base = document.getElementById('joy'), knob = document.getElementById('joy-knob');
  let jid = null, cx = 0, cy = 0;
  const R = 46;
  const move = t => {
    let dx = t.clientX - cx, dy = t.clientY - cy; const l = Math.hypot(dx, dy);
    if (l > R) { dx = dx / l * R; dy = dy / l * R; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const m = Math.min(1, l / R);
    Input.joy.x = m < 0.15 ? 0 : dx / R; Input.joy.y = m < 0.15 ? 0 : dy / R;
    Input.joy.on = m >= 0.15;
  };
  base.addEventListener('touchstart', e => {
    e.preventDefault(); Sound.init();
    const t = e.changedTouches[0]; jid = t.identifier;
    const r = base.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; move(t);
  }, { passive: false });
  base.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === jid) move(t);
  }, { passive: false });
  const end = e => {
    for (const t of e.changedTouches) if (t.identifier === jid) {
      jid = null; Input.joy.on = false; Input.joy.x = Input.joy.y = 0; knob.style.transform = '';
    }
  };
  base.addEventListener('touchend', end); base.addEventListener('touchcancel', end);
  tc.querySelectorAll('[data-k]').forEach(btn => {
    const k = btn.dataset.k;
    btn.addEventListener('touchstart', e => { e.preventDefault(); Sound.init(); Input.keys[k] = true; Input.hits[k] = true; btn.classList.add('on'); }, { passive: false });
    const up = e => { e.preventDefault(); Input.keys[k] = false; btn.classList.remove('on'); };
    btn.addEventListener('touchend', up); btn.addEventListener('touchcancel', up);
  });
}

// ==========================================================================
// 5. GENERACIÓN DE LA CIUDAD
// ==========================================================================
const World = {
  tiles: null, dyn: null, h: [], v: [], closed: new Set(),
  buildings: [], trees: [], lamps: [], potholes: new Map(), puddles: [],
  pois: [], stations: [], parking: [], courts: [], lots: [], stalls: [], reeds: [], pigeons: [],
  edges: [], airport: null, planes: [],
};

function tileAt(tx, ty) { return tx < 0 || ty < 0 || tx >= MW || ty >= MH ? -1 : World.tiles[ty * MW + tx]; }
function setTile(tx, ty, t) { if (tx >= 0 && ty >= 0 && tx < MW && ty < MH) World.tiles[ty * MW + tx] = t; }
function fillTiles(x, y, w, h, t) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) setTile(i, j, t); }
function tileAtPx(px, py) { return tileAt(Math.floor(px / T), Math.floor(py / T)); }
/** ¿Hay algo sólido (edificio, árbol, agua, barrera) en este punto del mundo? */
function solidAt(px, py) {
  const tx = Math.floor(px / T), ty = Math.floor(py / T);
  if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) return true;
  const i = ty * MW + tx;
  return SOLID_LUT[World.tiles[i]] === 1 || World.dyn[i] === 1;
}
function blockOf(px, py) { return [clamp(Math.floor((px / T - RW) / P), 0, BX - 1), clamp(Math.floor((py / T - RW) / P), 0, BY - 1)]; }
function districtAt(px, py) { const b = blockOf(px, py); return DISTRICT_GRID[b[1]][b[0]]; }
function districtUnlocked(d) { return G.rep >= DISTRICTS[d].rep; }
/**
 * Barrio que "manda" en un punto para efectos de bloqueo: una calle de frontera
 * pertenece al barrio vecino menos exigente, para no encerrar al jugador.
 */
function lockDistrictAt(px, py) {
  const tx = Math.floor(px / T), ty = Math.floor(py / T);
  const lx = ((tx % P) + P) % P, ly = ((ty % P) + P) % P;
  const cols = lx < RW ? [Math.floor(tx / P) - 1, Math.floor(tx / P)] : [Math.floor((tx - RW) / P)];
  const rows = ly < RW ? [Math.floor(ty / P) - 1, Math.floor(ty / P)] : [Math.floor((ty - RW) / P)];
  let best = null;
  for (const c of cols) for (const r of rows) {
    if (c < 0 || r < 0 || c >= BX || r >= BY) continue;
    const d = DISTRICT_GRID[r][c];
    if (!best || DISTRICTS[d].rep < DISTRICTS[best].rep) best = d;
  }
  return best || districtAt(px, py);
}
function canEnter(px, py) { return districtUnlocked(lockDistrictAt(px, py)); }

// --- Grafo de calles: nodos = intersecciones, aristas = cuadras ---
function hEdgeOk(i, j) { return i >= 0 && i < BX && j >= 0 && j <= BY && World.h[i][j]; }
function vEdgeOk(i, j) { return i >= 0 && i <= BX && j >= 0 && j < BY && World.v[i][j]; }
function edgeKey(i, j, dir) {
  switch (dir) { case 0: return 'h' + i + ',' + j; case 1: return 'v' + i + ',' + j; case 2: return 'h' + (i - 1) + ',' + j; default: return 'v' + i + ',' + (j - 1); }
}
/** Direcciones por las que se puede salir de una intersección. */
function nodeExits(i, j, ignoreClosed) {
  const out = [];
  const ok = d => ignoreClosed || !World.closed.has(edgeKey(i, j, d));
  if (hEdgeOk(i, j) && ok(0)) out.push(0);
  if (vEdgeOk(i, j) && ok(1)) out.push(1);
  if (hEdgeOk(i - 1, j) && ok(2)) out.push(2);
  if (vEdgeOk(i, j - 1) && ok(3)) out.push(3);
  return out;
}
function nodeHasRoad(i, j) { return nodeExits(i, j, true).length > 0; }
function nodeCenter(i, j) { return [i * PT + 48, j * PT + 48]; }
/** Coordenada transversal del carril (se maneja por la derecha). */
function laneCoord(dir, idx, tm) {
  const b = idx * PT;
  if (tm) return dir === 0 || dir === 1 ? b + 56 : b + 40;
  return dir === 0 || dir === 3 ? b + 80 : b + 16;
}
function isTroncalEdge(i, j, d) { return d % 2 === 0 ? j === 6 : i === 4; }
function nearestNode(x, y) {
  let i = clamp(Math.round((x - 48) / PT), 0, BX), j = clamp(Math.round((y - 48) / PT), 0, BY);
  if (nodeHasRoad(i, j)) return [i, j];
  let best = null, bd = 1e9;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const ni = i + a, nj = j + b;
    if (ni < 0 || nj < 0 || ni > BX || nj > BY || !nodeHasRoad(ni, nj)) continue;
    const c = nodeCenter(ni, nj), dd = dist(x, y, c[0], c[1]);
    if (dd < bd) { bd = dd; best = [ni, nj]; }
  }
  return best || [0, 0];
}
/** Línea de visión libre de edificios. */
function losClear(x0, y0, x1, y1) {
  const d = dist(x0, y0, x1, y1), n = Math.ceil(d / 14);
  for (let k = 1; k < n; k++) {
    const t = k / n, tx = Math.floor(lerp(x0, x1, t) / T), ty = Math.floor(lerp(y0, y1, t) / T);
    const tl = tileAt(tx, ty);
    if (tl === TILE.BUILDING || tl < 0) return false;
  }
  return true;
}
/** BFS sobre el grafo de calles: distancia en cuadras desde un nodo. */
function bfsFrom(si, sj) {
  const W = BX + 1, out = new Int16Array(W * (BY + 1)).fill(-1), q = [si, sj];
  out[sj * W + si] = 0;
  for (let h = 0; h < q.length; h += 2) {
    const i = q[h], j = q[h + 1], dv = out[j * W + i];
    for (const d of nodeExits(i, j)) {
      const ni = i + DIRV[d][0], nj = j + DIRV[d][1];
      if (out[nj * W + ni] < 0) { out[nj * W + ni] = dv + 1; q.push(ni, nj); }
    }
  }
  return out;
}
/** Ruta (lista de nodos) para el GPS. */
function routeNodes(fx, fy, tx, ty) {
  const a = nearestNode(fx, fy), b = nearestNode(tx, ty), W = BX + 1;
  const field = bfsFrom(b[0], b[1]);
  const path = [a]; let cur = a, guard = 0;
  while ((cur[0] !== b[0] || cur[1] !== b[1]) && guard++ < 60) {
    const cd = field[cur[1] * W + cur[0]]; if (cd < 0) break;
    let nxt = null;
    for (const d of nodeExits(cur[0], cur[1])) {
      const ni = cur[0] + DIRV[d][0], nj = cur[1] + DIRV[d][1];
      if (field[nj * W + ni] === cd - 1) { nxt = [ni, nj]; break; }
    }
    if (!nxt) break;
    path.push(nxt); cur = nxt;
  }
  return path;
}

function sidewalkTile(bi, bj, side, off) {
  const x0 = bi * P + RW, y0 = bj * P + RW, x1 = x0 + 12, y1 = y0 + 12;
  switch (side) { case 'N': return [x0 + off, y0]; case 'S': return [x0 + off, y1]; case 'W': return [x0, y0 + off]; default: return [x1, y0 + off]; }
}
/** Punto aleatorio en una acera, con filtro opcional por barrio/posición. */
function randomSidewalkPoint(filter) {
  for (let k = 0; k < 300; k++) {
    const bi = randi(0, BX - 1), bj = randi(0, BY - 1), d = DISTRICT_GRID[bj][bi];
    if (d === 'A') continue;
    const side = pick(['N', 'S', 'W', 'E']), off = randi(2, 10);
    const [tx, ty] = sidewalkTile(bi, bj, side, off);
    const x = (tx + 0.5) * T, y = (ty + 0.5) * T;
    if (filter && !filter(d, x, y)) continue;
    if (World.pois.some(p => dist(p.x, p.y, x, y) < 48)) continue;
    return { x, y, d, side };
  }
  return null;
}

function genWorld() {
  const rng = mulberry32(CITY.seed);
  const W = World;
  Object.assign(W, {
    h: [], v: [], closed: new Set(), buildings: [], trees: [], lamps: [], potholes: new Map(), puddles: [],
    pois: [], stations: [], parking: [], courts: [], lots: [], stalls: [], reeds: [], pigeons: [], edges: [],
    airport: null, planes: [], umbrellas: [], statues: [],
  });
  chunkCache.clear();
  W.tiles = new Uint8Array(MW * MH).fill(TILE.GRASS);
  W.dyn = new Uint8Array(MW * MH);
  for (let i = 0; i < BX; i++) { W.h[i] = []; for (let j = 0; j <= BY; j++) W.h[i][j] = true; }
  for (let i = 0; i <= BX; i++) { W.v[i] = []; for (let j = 0; j < BY; j++) W.v[i][j] = true; }
  // El aeropuerto es una sola zona grande sin calles internas
  for (const j of [3, 4, 5]) { W.h[0][j] = false; W.h[1][j] = false; }
  for (const j of [2, 3, 4, 5]) W.v[1][j] = false;
  // Calles
  for (let i = 0; i <= BX; i++) for (let j = 0; j <= BY; j++) if (nodeHasRoad(i, j)) fillTiles(i * P, j * P, RW, RW, TILE.ROAD);
  for (let i = 0; i < BX; i++) for (let j = 0; j <= BY; j++) if (W.h[i][j]) { fillTiles(i * P + RW, j * P, P - RW, RW, TILE.ROAD); W.edges.push({ h: true, i, j }); }
  for (let i = 0; i <= BX; i++) for (let j = 0; j < BY; j++) if (W.v[i][j]) { fillTiles(i * P, j * P + RW, RW, P - RW, TILE.ROAD); W.edges.push({ h: false, i, j }); }
  // Manzanas
  for (let bj = 0; bj < BY; bj++) for (let bi = 0; bi < BX; bi++) {
    const d = DISTRICT_GRID[bj][bi];
    if (d !== 'A') genBlock(bi, bj, d, rng);
  }
  genAirport(rng);
  // Hito del Centro: la torre más grande se vuelve el rascacielos icónico
  let tallest = null;
  if (CITY.id === 'bogota') for (const b of W.buildings) if (b.d === 'D' && b.kind === 'ac' && (!tallest || b.tw * b.th > tallest.tw * tallest.th)) tallest = b;
  if (tallest) { tallest.kind = 'tower'; tallest.height = 95; tallest.lift = 26; }
  genPOIs();
  genStreetTrees(rng);
  genLamps();
  genPotholes(rng);
}

function addBuilding(tx, ty, tw, th, d, rng, o = {}) {
  const st = STYLE[d] || KIT.centro;
  const height = o.height || Math.round(lerp(st.h[0], st.h[1], rng()) * (0.75 + Math.min(tw, th) / 12));
  const b = {
    x: tx * T, y: ty * T, w: tw * T, h: th * T, tw, th, d, height,
    lift: o.lift || clamp(Math.round(height * 0.42), 5, 22),
    roof: o.roof || pickR(rng, st.roofs), wall: o.wall || pickR(rng, st.walls),
    kind: o.kind || st.kind, seed: (rng() * 1e9) | 0,
    neon: pickR(rng, ['#00e5ff', '#ff3dcd', '#b388ff', '#69f0ae', '#ffd740']),
  };
  b.patio = (st.kind === 'tejas' && st.walls === BOG_STYLE.L.walls || st.balcony) && tw >= 4 && th >= 4 && !o.kind;
  b.graffiti = !!st.graffiti && !o.kind; b.balcony = !!st.balcony && !o.kind;
  b.roofDark = shade(b.roof, -0.22); b.roofLight = shade(b.roof, 0.18); b.wallDark = shade(b.wall, -0.3);
  World.buildings.push(b);
  fillTiles(tx, ty, tw, th, TILE.BUILDING);
  return b;
}

/** Divide un rectángulo en lotes (con callejones de 1 tile a veces). */
function splitLots(rng, x, y, w, h, minS, gapP, out, depth) {
  const big = w * h > minS * minS * 3.2;
  const canH = h >= minS * 2, canW = w >= minS * 2;
  if ((!canH && !canW) || (!big && rng() < 0.55) || depth > 6) { out.push({ x, y, w, h }); return; }
  const horiz = canH && (!canW || h > w || (h === w && rng() < 0.5));
  const len = horiz ? h : w;
  let gap = rng() < gapP ? 1 : 0;
  if (len - gap - 2 * minS < 0) gap = 0;
  const span = len - gap - 2 * minS;
  if (span < 0) { out.push({ x, y, w, h }); return; }
  const s = minS + Math.floor(rng() * (span + 1));
  if (horiz) {
    splitLots(rng, x, y, w, s, minS, gapP, out, depth + 1);
    splitLots(rng, x, y + s + gap, w, h - s - gap, minS, gapP, out, depth + 1);
  } else {
    splitLots(rng, x, y, s, h, minS, gapP, out, depth + 1);
    splitLots(rng, x + s + gap, y, w - s - gap, h, minS, gapP, out, depth + 1);
  }
}

function addTree(tx, ty, rng, solid = true, r) {
  if (solid) setTile(tx, ty, TILE.TREE);
  const c = pickR(rng, ['#3f8f3a', '#4a9b3f', '#2f7a35', '#3d8a44', '#57a14a']);
  World.trees.push({ x: (tx + 0.5) * T + (rng() - 0.5) * 6, y: (ty + 0.5) * T + (rng() - 0.5) * 6, r: r || 13 + rng() * 6, c, c2: shade(c, 0.2), solid, palm: CITY.palms && rng() < 0.6 });
}

function genBlock(bi, bj, d, rng) {
  const x0 = bi * P + RW, y0 = bj * P + RW, x1 = x0 + 12, y1 = y0 + 12;
  for (let x = x0; x <= x1; x++) { setTile(x, y0, TILE.SIDEWALK); setTile(x, y1, TILE.SIDEWALK); }
  for (let y = y0; y <= y1; y++) { setTile(x0, y, TILE.SIDEWALK); setTile(x1, y, TILE.SIDEWALK); }
  const ix = x0 + 1, iy = y0 + 1, n = 11;
  const park = PARKS[bi + ',' + bj];
  if (park) { genPark(park, ix, iy, n, rng, d); return; }
  fillTiles(ix, iy, n, n, TILE.PLAZA);
  const st = STYLE[d], lots = [];
  splitLots(rng, ix, iy, n, n, st.minS, st.gap, lots, 0);
  for (const L of lots) {
    const r = rng();
    if (r < st.court && L.w >= 3 && L.h >= 3 && L.w * L.h >= 12) {
      World.courts.push({ x: L.x * T, y: L.y * T, w: L.w * T, h: L.h * T });
      continue;
    }
    if (r < st.court + st.empty && L.w * L.h >= 6 && L.h >= 2) {
      World.lots.push({ x: L.x * T, y: L.y * T, w: L.w * T, h: L.h * T });
      for (let k = 0; k < L.w; k++) World.parking.push({ x: (L.x + k + 0.5) * T, y: (L.y + L.h / 2) * T, a: -Math.PI / 2 });
      continue;
    }
    addBuilding(L.x, L.y, L.w, L.h, d, rng);
  }
}

function genPark(park, ix, iy, n, rng, d) {
  const W = World;
  switch (park.kind) {
    case 'park': {
      fillTiles(ix, iy, n, n, TILE.GRASS);
      fillTiles(ix, iy + 5, n, 1, TILE.PLAZA); fillTiles(ix + 5, iy, 1, n, TILE.PLAZA);
      fillTiles(ix + 4, iy + 4, 3, 3, TILE.PLAZA); setTile(ix + 5, iy + 5, TILE.WATER);
      for (let y = iy; y < iy + n; y++) for (let x = ix; x < ix + n; x++) {
        if (tileAt(x, y) !== TILE.GRASS) continue;
        if (Math.abs(x - ix - 5) <= 1 || Math.abs(y - iy - 5) <= 1) continue;
        if (rng() < 0.28) addTree(x, y, rng);
      }
      break;
    }
    case 'park93': {
      fillTiles(ix, iy, n, n, TILE.GRASS);
      fillTiles(ix + 1, iy + 1, 9, 1, TILE.PLAZA); fillTiles(ix + 1, iy + 9, 9, 1, TILE.PLAZA);
      fillTiles(ix + 1, iy + 1, 1, 9, TILE.PLAZA); fillTiles(ix + 9, iy + 1, 1, 9, TILE.PLAZA);
      fillTiles(ix + 4, iy + 4, 3, 3, TILE.PLAZA);
      fillTiles(ix + 5, iy, 1, 11, TILE.PLAZA); fillTiles(ix, iy + 5, 11, 1, TILE.PLAZA);
      for (let y = iy; y < iy + n; y++) for (let x = ix; x < ix + n; x++)
        if (tileAt(x, y) === TILE.GRASS && rng() < 0.38) addTree(x, y, rng);
      break;
    }
    case 'humedal': {
      fillTiles(ix, iy, n, n, TILE.GRASS);
      for (let y = iy; y < iy + n; y++) for (let x = ix; x < ix + n; x++) {
        const dx = (x - (ix + 5)) / 4.6, dy = (y - (iy + 4)) / 3.4;
        if (dx * dx + dy * dy < 1) setTile(x, y, TILE.WATER);
        else if (dx * dx + dy * dy < 1.5 && rng() < 0.5) W.reeds.push({ x: (x + rng()) * T, y: (y + rng()) * T });
      }
      fillTiles(ix, iy + 9, n, 1, TILE.PLAZA);
      for (let y = iy; y < iy + n; y++) for (let x = ix; x < ix + n; x++)
        if (tileAt(x, y) === TILE.GRASS && y < iy + 9 && rng() < 0.18) addTree(x, y, rng);
      break;
    }
    case 'plaza': {
      fillTiles(ix, iy, n, n, TILE.PLAZA);
      addBuilding(ix + 2, iy, 7, 3, 'L', rng, { height: 44, lift: 22, kind: 'cathedral', roof: '#8d8a84', wall: '#d8cdb8' });
      addBuilding(ix + 1, iy + 9, 9, 2, 'L', rng, { height: 24, lift: 14, kind: 'capitol', roof: '#aaa59b', wall: '#e2dccd' });
      addBuilding(ix + 5, iy + 5, 1, 1, 'L', rng, { height: 16, lift: 10, kind: 'statue', roof: '#b0a999', wall: '#8f887a' });
      for (let k = 0; k < 26; k++) W.pigeons.push({ x: (ix + 1 + rng() * 9) * T, y: (iy + 3.5 + rng() * 5) * T, t: rng() * 10, fly: 0, vx: 0, vy: 0 });
      break;
    }
    case 'usaquen': {
      fillTiles(ix, iy, n, n, TILE.GRASS);
      fillTiles(ix + 2, iy + 2, 7, 7, TILE.PLAZA);
      fillTiles(ix + 5, iy, 1, n, TILE.PLAZA); fillTiles(ix, iy + 5, n, 1, TILE.PLAZA);
      const cols = ['#e53935', '#1e88e5', '#fdd835', '#43a047', '#fb8c00', '#8e24aa'];
      for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++)
        W.stalls.push({ x: (ix + 2.6 + c * 2.3) * T, y: (iy + 3 + r * 3.4) * T, c: pickR(rng, cols) });
      for (let y = iy; y < iy + n; y++) for (let x = ix; x < ix + n; x++)
        if (tileAt(x, y) === TILE.GRASS && rng() < 0.45) addTree(x, y, rng);
      break;
    }
    case 'beach': { // playa: arena, mar hacia el borde del mapa, palmas y sombrillas
      fillTiles(ix, iy, n, n, TILE.SAND);
      const [bi, bj] = blockOf(ix * T, iy * T);
      if (bi === 0) fillTiles(ix, iy, 4, n, TILE.WATER);
      if (bj === BY - 1) fillTiles(ix, iy + 7, n, 4, TILE.WATER);
      const cols = ['#e53935', '#fdd835', '#1e88e5', '#43a047', '#ff6d00', '#ec407a'];
      for (let y = iy; y < iy + n; y++) for (let x = ix; x < ix + n; x++) {
        if (tileAt(x, y) !== TILE.SAND) continue;
        const rr = rng();
        if (rr < 0.12) addTree(x, y, rng, true, 14);
        else if (rr < 0.3) W.umbrellas.push({ x: (x + 0.5) * T, y: (y + 0.5) * T, c: pickR(rng, cols) });
      }
      break;
    }
    case 'muralla': { // baluartes de piedra con cañones
      fillTiles(ix, iy, n, n, TILE.GRASS);
      fillTiles(ix + 2, iy + 2, 7, 7, TILE.PLAZA);
      const o = { height: 26, lift: 12, kind: 'wall', roof: '#c2a878', wall: '#9c8558' };
      addBuilding(ix, iy, 4, 2, 'M', rng, o); addBuilding(ix + 7, iy, 4, 2, 'M', rng, o);
      addBuilding(ix, iy + 9, 4, 2, 'M', rng, o); addBuilding(ix + 7, iy + 9, 4, 2, 'M', rng, o);
      addBuilding(ix, iy + 2, 2, 2, 'M', rng, o); addBuilding(ix, iy + 7, 2, 2, 'M', rng, o);
      addBuilding(ix + 9, iy + 2, 2, 2, 'M', rng, o); addBuilding(ix + 9, iy + 7, 2, 2, 'M', rng, o);
      for (let k = 0; k < 4; k++) W.statues.push({ x: (ix + 3 + k * 1.7) * T, y: (iy + 5.5) * T, kind: 'cannon' });
      break;
    }
    case 'reloj': {
      fillTiles(ix, iy, n, n, TILE.PLAZA);
      addBuilding(ix + 4, iy + 3, 3, 3, 'M', rng, { height: 60, lift: 24, kind: 'reloj', roof: '#f2c94c', wall: '#e0a93b' });
      const cols = ['#e53935', '#1e88e5', '#fdd835', '#43a047'];
      for (let k = 0; k < 4; k++) W.stalls.push({ x: (ix + 1.8 + k * 2.4) * T, y: (iy + 8.6) * T, c: pickR(rng, cols) });
      break;
    }
    case 'castillo': {
      fillTiles(ix, iy, n, n, TILE.GRASS);
      fillTiles(ix + 5, iy + 9, 1, 2, TILE.PLAZA);
      addBuilding(ix + 1, iy + 1, 9, 8, 'M', rng, { height: 44, lift: 18, kind: 'castillo', roof: '#b39b72', wall: '#8f7a55' });
      break;
    }
    case 'botero': {
      fillTiles(ix, iy, n, n, TILE.PLAZA);
      for (const [a, b] of [[2, 2], [7, 2], [2, 7], [7, 7], [5, 4], [4, 8]]) addBuilding(ix + a, iy + b, 1, 1, 'C', rng, { height: 16, lift: 8, kind: 'botero', roof: '#6d4c2f', wall: '#4e3620' });
      for (const [a, b] of [[0, 0], [10, 0], [0, 10], [10, 10]]) addTree(ix + a, iy + b, rng);
      for (let k = 0; k < 20; k++) W.pigeons.push({ x: (ix + 1 + rng() * 9) * T, y: (iy + 1 + rng() * 9) * T, t: rng() * 10, fly: 0, vx: 0, vy: 0 });
      break;
    }
    case 'rio': { // Bulevar del Río (Cali)
      fillTiles(ix, iy, n, n, TILE.PLAZA);
      fillTiles(ix, iy + 4, n, 3, TILE.WATER);
      for (let x = ix; x < ix + n; x += 2) { addTree(x, iy + 1, rng, true, 13); addTree(x + 1, iy + 9, rng, true, 13); }
      break;
    }
    case 'gato': {
      fillTiles(ix, iy, n, n, TILE.GRASS);
      fillTiles(ix + 3, iy + 3, 5, 5, TILE.PLAZA); fillTiles(ix + 5, iy, 1, n, TILE.PLAZA);
      fillTiles(ix + 8, iy, 3, n, TILE.WATER);
      addBuilding(ix + 4, iy + 4, 2, 2, 'C', rng, { height: 24, lift: 12, kind: 'gato', roof: '#5d4037', wall: '#3e2723' });
      for (let y = iy; y < iy + n; y++) for (let x = ix; x < ix + 8; x++) if (tileAt(x, y) === TILE.GRASS && rng() < 0.35) addTree(x, y, rng);
      break;
    }
    case 'malecon': { // Gran Malecón del río Magdalena
      fillTiles(ix, iy, n, n, TILE.PLAZA);
      const [bi] = blockOf(ix * T, iy * T);
      if (bi === BX - 1) fillTiles(ix + 6, iy, 5, n, TILE.WATER);
      for (let y = iy; y < iy + n; y += 2) addTree(ix + (bi === BX - 1 ? 5 : 1 + (y % 4)), y, rng, true, 13);
      if (rng() < 0.6) W.stalls.push({ x: (ix + 2.5) * T, y: (iy + 5) * T, c: pickR(rng, ['#e53935', '#fdd835', '#1e88e5']) });
      break;
    }
  }
}

function genAirport(rng) {
  const W = World;
  const ax = 3, ay = 35, aw = 29, ah = 61;
  fillTiles(ax, ay, aw, ah, TILE.GRASS);
  for (let x = ax; x < ax + aw; x++) { setTile(x, ay, TILE.SIDEWALK); setTile(x, ay + ah - 1, TILE.SIDEWALK); }
  for (let y = ay; y < ay + ah; y++) { setTile(ax, y, TILE.SIDEWALK); setTile(ax + aw - 1, y, TILE.SIDEWALK); }
  fillTiles(7, 39, 5, 53, TILE.RUNWAY);                 // pista
  fillTiles(12, 45, 6, 2, TILE.APRON); fillTiles(12, 84, 6, 2, TILE.APRON); // calles de rodaje
  fillTiles(16, 45, 2, 41, TILE.APRON);
  fillTiles(18, 48, 4, 24, TILE.APRON);                 // plataforma
  addBuilding(22, 50, 7, 16, 'D', rng, { height: 30, lift: 14, kind: 'terminal', roof: '#cfd6dd', wall: '#7f8c99' });
  fillTiles(29, 50, 2, 16, TILE.PLAZA);                 // andén de llegada
  addBuilding(22, 72, 7, 6, 'D', rng, { height: 20, lift: 12, kind: 'hangar', roof: '#9aa5ae', wall: '#5e6a74' });
  addBuilding(24, 40, 2, 2, 'D', rng, { height: 46, lift: 22, kind: 'ac', roof: '#e0e0e0', wall: '#90a4ae' });
  fillTiles(22, 82, 9, 10, TILE.PLAZA);                 // parqueadero
  W.lots.push({ x: 22 * T, y: 82 * T, w: 9 * T, h: 10 * T });
  for (let r = 0; r < 3; r++) for (let k = 0; k < 9; k++) W.parking.push({ x: (22 + k + 0.5) * T, y: (83.5 + r * 3) * T, a: -Math.PI / 2 });
  W.airport = { x: 30.5 * T, y: 58 * T };
  // Aviones parqueados en la plataforma
  W.planes.push({ x: 19.5 * T, y: 53 * T, a: 0, parked: true }, { x: 19.5 * T, y: 64 * T, a: 0, parked: true });
  for (let k = 0; k < 18; k++) {
    const x = ax + 2 + Math.floor(rng() * 3), y = ay + 3 + Math.floor(rng() * (ah - 6));
    if (tileAt(x, y) === TILE.GRASS) addTree(x, y, rng);
  }
}

function poiMeta(p) {
  switch (p.type) {
    case 'home': return p.home === 'hotel' ? { name: 'Hotel ' + CITY.nick, icon: '🏨', color: '#4fc3f7' } : { name: HOMES[p.home].name, icon: '🏠', color: '#4fc3f7' };
    case 'shop': return { name: SHOPS[p.shop].name, icon: SHOPS[p.shop].icon, color: SHOPS[p.shop].color };
    case 'hospital': return { name: CITY.id !== 'bogota' ? 'Hospital Universitario' : p.id === 'hosp1' ? 'Hospital San Juan' : 'Clínica del Norte', icon: '🏥', color: '#ef5350' };
    case 'police': return { name: 'Estación de Policía', icon: '🚓', color: '#42a5f5' };
    case 'mechanic': return { name: 'Taller El Mono', icon: '🔧', color: '#ffb74d' };
    case 'carwash': return { name: 'Lavadero y Placas', icon: '🧽', color: '#4dd0e1' };
    case 'market': return { name: MARKETS[p.market].name, icon: '💰', color: '#ffd54f' };
    case 'business': return { name: BIZ[p.biz].name, icon: BIZ[p.biz].icon, color: '#81c784' };
    case 'giver': return { name: p.npc, icon: MISSION_INFO[p.mission].icon, color: MISSION_INFO[p.mission].color };
    case 'club': return { name: p.name || 'Discoteca Galáctica', icon: '🪩', color: '#e040fb' };
    case 'atm': return { name: 'Cajero automático', icon: '🏧', color: '#90a4ae' };
    case 'hide': return { name: 'Escondite', icon: '🌿', color: '#66bb6a' };
    case 'airport': return { name: 'Aeropuerto ' + CITY.airport + ' · Vuelos', icon: '✈️', color: '#4fc3f7' };
    case 'station': return { name: 'Estación ' + p.station, icon: '🚉', color: '#e53935' };
  }
  return { name: '?', icon: '?', color: '#fff' };
}

/** Escoge un andén libre dentro del barrio pedido (para las ciudades nuevas). */
function autoPlace(def, rng) {
  const blocks = [];
  for (let bj = 0; bj < BY; bj++) for (let bi = 0; bi < BX; bi++)
    if (DISTRICT_GRID[bj][bi] === def.d && !PARKS[bi + ',' + bj]) blocks.push([bi, bj]);
  if (!blocks.length) for (let bj = 0; bj < BY; bj++) for (let bi = 0; bi < BX; bi++) if (DISTRICT_GRID[bj][bi] !== 'A' && !PARKS[bi + ',' + bj]) blocks.push([bi, bj]);
  for (let k = 0; k < 400; k++) {
    const b = pickR(rng, blocks), side = pickR(rng, ['N', 'S', 'W', 'E']), off = 2 + Math.floor(rng() * 9);
    const [tx, ty] = sidewalkTile(b[0], b[1], side, off);
    const x = (tx + 0.5) * T, y = (ty + 0.5) * T;
    const minD = k < 300 ? 76 : 44;
    if (World.pois.some(p => dist(p.x, p.y, x, y) < minD)) continue;
    if (BOG_STATIONS.some(st => dist((st.tx + 0.5) * T, (st.ty + 0.5) * T, x, y) < 110)) continue;
    return { b, side, off };
  }
  return { b: blocks[0], side: 'N', off: 6 };
}

function genPOIs() {
  const W = World;
  const rng = mulberry32(CITY.seed + 77);
  for (const d0 of POI_DEFS) {
    const def = d0.b ? d0 : Object.assign({}, d0, autoPlace(d0, rng));
    const [tx, ty] = sidewalkTile(def.b[0], def.b[1], def.side, def.off);
    const p = Object.assign({}, def, { x: (tx + 0.5) * T, y: (ty + 0.5) * T, tx, ty });
    Object.assign(p, poiMeta(p));
    W.pois.push(p);
  }
  const ap = { id: 'airport', type: 'airport', x: W.airport.x, y: W.airport.y, side: 'E' };
  Object.assign(ap, poiMeta(ap)); W.pois.push(ap);
  BOG_STATIONS.forEach((sd0, i) => {
    const sd = Object.assign({}, sd0, { name: CITY.stationNames[i] });
    const p = { id: 'st_' + sd.name, type: 'station', station: sd.name, axis: sd.axis, x: (sd.tx + 0.5) * T, y: (sd.ty + 0.5) * T, side: sd.axis === 'h' ? 'N' : (sd.tx % P === RW ? 'W' : 'E') };
    Object.assign(p, poiMeta(p));
    W.pois.push(p); W.stations.push(p);
  });
}

function genStreetTrees(rng) {
  const prob = CITY.id === 'bogota' ? { U: 0.3, S: 0.22, C: 0.2, Z: 0.16, K: 0.08, L: 0.04, D: 0.07 } : null;
  for (let bj = 0; bj < BY; bj++) for (let bi = 0; bi < BX; bi++) {
    const d = DISTRICT_GRID[bj][bi]; if (d === 'A') continue;
    for (const side of ['N', 'S', 'W', 'E']) for (let off = 2; off <= 10; off += 2) {
      if (rng() > (prob ? prob[d] : CITY.palms ? 0.2 : 0.18)) continue;
      const [tx, ty] = sidewalkTile(bi, bj, side, off);
      const x = (tx + 0.5) * T, y = (ty + 0.5) * T;
      if (World.pois.some(p => dist(p.x, p.y, x, y) < 56)) continue;
      const c = pickR(rng, ['#3f8f3a', '#4a9b3f', '#2f7a35', '#5aa64c']);
      World.trees.push({ x, y, r: 11 + rng() * 4, c, c2: shade(c, 0.2), solid: false, palm: CITY.palms && rng() < 0.75 });
    }
  }
}

function genLamps() {
  const L = World.lamps;
  for (let bj = 0; bj < BY; bj++) for (let bi = 0; bi < BX; bi++) {
    if (DISTRICT_GRID[bj][bi] === 'A') continue;
    const x0 = (bi * P + RW) * T, y0 = (bj * P + RW) * T, s = 13 * T;
    L.push({ x: x0 + 6, y: y0 + 6 }, { x: x0 + s - 6, y: y0 + 6 }, { x: x0 + 6, y: y0 + s - 6 }, { x: x0 + s - 6, y: y0 + s - 6 });
    L.push({ x: x0 + s / 2, y: y0 + 6 }, { x: x0 + s / 2, y: y0 + s - 6 }, { x: x0 + 6, y: y0 + s / 2 }, { x: x0 + s - 6, y: y0 + s / 2 });
  }
  for (let k = 0; k < 8; k++) L.push({ x: 31.5 * T - 8, y: (37 + k * 8) * T });
}

function genPotholes(rng) {
  let made = 0;
  while (made < 170) {
    const tx = Math.floor(rng() * MW), ty = Math.floor(rng() * MH);
    if (tileAt(tx, ty) !== TILE.ROAD) continue;
    const lx = tx % P, ly = ty % P;
    if (lx < RW && ly < RW) continue;
    const key = ty * MW + tx;
    if (World.potholes.has(key)) continue;
    World.potholes.set(key, { x: (tx + 0.25 + rng() * 0.5) * T, y: (ty + 0.25 + rng() * 0.5) * T, r: 5 + rng() * 4 });
    made++;
  }
  for (let k = 0; k < 300; k++) {
    const tx = Math.floor(rng() * MW), ty = Math.floor(rng() * MH), t = tileAt(tx, ty);
    if (t === TILE.ROAD || t === TILE.SIDEWALK || t === TILE.PLAZA)
      World.puddles.push({ x: (tx + rng()) * T, y: (ty + rng()) * T, rx: 8 + rng() * 14, ry: 5 + rng() * 7 });
  }
}

// ==========================================================================
// 6. RENDER DE LA CIUDAD
// ==========================================================================
const CHUNK = 16, CHUNK_PX = CHUNK * T;
const chunkCache = new Map();
function circ(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }

/** Devuelve (y cachea) la capa de piso de un chunk de 16x16 tiles. */
function getChunk(cx, cy) {
  const key = cx + ',' + cy;
  let c = chunkCache.get(key);
  if (c) { chunkCache.delete(key); chunkCache.set(key, c); return c; }
  c = document.createElement('canvas');
  c.width = c.height = CHUNK_PX;
  renderChunk(c.getContext('2d'), cx, cy);
  chunkCache.set(key, c);
  if (chunkCache.size > 56) chunkCache.delete(chunkCache.keys().next().value);
  return c;
}

function renderChunk(g, cx, cy) {
  const tx0 = cx * CHUNK, ty0 = cy * CHUNK;
  for (let ty = ty0; ty < ty0 + CHUNK; ty++)
    for (let tx = tx0; tx < tx0 + CHUNK; tx++) drawTile(g, tx, ty, (tx - tx0) * T, (ty - ty0) * T);
  g.save();
  g.translate(-tx0 * T, -ty0 * T);
  const X0 = tx0 * T - 40, Y0 = ty0 * T - 40, X1 = X0 + CHUNK_PX + 80, Y1 = Y0 + CHUNK_PX + 80;
  const inR = (x, y, w, h) => x < X1 && x + w > X0 && y < Y1 && y + h > Y0;
  for (const c of World.courts) if (inR(c.x, c.y, c.w, c.h)) drawCourt(g, c);
  for (const l of World.lots) if (inR(l.x, l.y, l.w, l.h)) drawParkingLot(g, l);
  for (const p of World.potholes.values()) if (inR(p.x - 12, p.y - 12, 24, 24)) drawPothole(g, p);
  for (const r of World.reeds) if (inR(r.x - 6, r.y - 10, 12, 14)) drawReeds(g, r);
  for (const b of World.buildings) if (inR(b.x, b.y - 30, b.w + 30, b.h + 40)) drawBuildingShadow(g, b);
  for (const b of World.buildings) if (inR(b.x, b.y, b.w, b.h)) drawBuildingWall(g, b);
  g.restore();
}

const dStyle = d => STYLE[d] || KIT.centro;
const isCobble = d => dStyle(d).walls === BOG_STYLE.L.walls || !!dStyle(d).balcony;
/** Lo que se ve fuera de la ciudad: cerros, sabana, caña, mar, río o manglar. */
function drawOutside(g, tx, ty, px, py, r) {
  const side = tx >= MW ? 'E' : tx < 0 ? 'W' : ty < 0 ? 'N' : 'S';
  const kind = CITY.outside[side];
  const near = Math.max(tx - MW + 1, -tx, -ty, ty - MH + 1); // tiles de distancia al borde
  switch (kind) {
    case 'sea': case 'river': case 'manglar': {
      if (kind === 'sea' && near <= 2) { g.fillStyle = '#e9d59a'; g.fillRect(px, py, T, T); g.fillStyle = '#d6bf7c'; g.fillRect(px + r * 24, py + 10, 3, 3); return; }
      g.fillStyle = kind === 'sea' ? (near < 5 ? '#2f9fc4' : '#1f78a8') : kind === 'river' ? '#7d6b4f' : '#3d6b4f';
      g.fillRect(px, py, T, T);
      g.fillStyle = kind === 'river' ? 'rgba(255,240,200,.18)' : 'rgba(255,255,255,.22)';
      g.fillRect(px + r * 18, py + 8 + r * 10, 12, 2);
      if (kind === 'manglar' && r > 0.5) { g.fillStyle = '#2e5e34'; circ(g, px + 16, py + 16, 9 + r * 5); }
      return;
    }
    case 'cana': {
      g.fillStyle = r < 0.5 ? '#6fa84a' : '#79b24f'; g.fillRect(px, py, T, T);
      g.fillStyle = '#5a9440'; for (let k = 0; k < 4; k++) g.fillRect(px + k * 8 + 2, py, 2, T);
      return;
    }
    case 'mount': {
      g.fillStyle = r < 0.5 ? '#2c5631' : '#305b35'; g.fillRect(px, py, T, T);
      if (r > 0.55) { g.fillStyle = 'rgba(18,48,24,.7)'; circ(g, px + 16, py + 16, 8 + r * 8); }
      if (CITY.id === 'medellin' && near < 8 && r < 0.3) { // casitas en las lomas
        g.fillStyle = pick(['#e53935', '#fdd835', '#1e88e5', '#fb8c00', '#ffffff', '#b5523b']); g.fillRect(px + 6, py + 8, 12, 10);
        g.fillStyle = '#8a8f99'; g.fillRect(px + 5, py + 6, 14, 3);
      }
      return;
    }
    default: {
      g.fillStyle = r < 0.5 ? '#5c8442' : '#618a46'; g.fillRect(px, py, T, T);
      if (r > 0.55) { g.fillStyle = 'rgba(70,110,50,.6)'; circ(g, px + 16, py + 16, 8 + r * 8); }
      if (r < 0.06) { g.fillStyle = '#e8e2d0'; g.fillRect(px + 10, py + 12, 10, 8); g.fillStyle = '#b5523b'; g.fillRect(px + 8, py + 8, 14, 5); }
    }
  }
}

function drawTile(g, tx, ty, px, py) {
  const t = tileAt(tx, ty), r = h2(tx, ty);
  if (t < 0) { drawOutside(g, tx, ty, px, py, r); return; }
  const d = districtAt((tx + 0.5) * T, (ty + 0.5) * T);
  switch (t) {
    case TILE.ROAD: drawRoadTile(g, tx, ty, px, py, d); break;
    case TILE.SIDEWALK: {
      g.fillStyle = isCobble(d) ? '#c4b49a' : dStyle(d).kind === 'glass' ? '#c9c6cf' : d === 'A' ? '#c2c2bc' : '#bdb6a8';
      g.fillRect(px, py, T, T);
      g.fillStyle = 'rgba(0,0,0,.08)'; g.fillRect(px, py + 15, T, 1); g.fillRect(px + 15, py, 1, T);
      g.fillStyle = '#8a8478';
      if (tileAt(tx, ty - 1) === TILE.ROAD) g.fillRect(px, py, T, 3);
      if (tileAt(tx, ty + 1) === TILE.ROAD) g.fillRect(px, py + T - 3, T, 3);
      if (tileAt(tx - 1, ty) === TILE.ROAD) g.fillRect(px, py, 3, T);
      if (tileAt(tx + 1, ty) === TILE.ROAD) g.fillRect(px + T - 3, py, 3, T);
      break;
    }
    case TILE.GRASS: case TILE.TREE: {
      g.fillStyle = d === 'A' || CITY.palms ? '#7ea65c' : '#5b9a48'; g.fillRect(px, py, T, T);
      for (let k = 0; k < 5; k++) {
        g.fillStyle = k % 2 ? '#6db257' : '#4c8a3c';
        g.fillRect(px + h2(tx * 3 + k, ty) * 29, py + h2(tx, ty * 3 + k) * 29, 2, 3);
      }
      if (t === TILE.TREE) { g.fillStyle = '#5d4037'; g.fillRect(px + 14, py + 14, 4, 4); }
      break;
    }
    case TILE.PLAZA: {
      g.fillStyle = dStyle(d).kind === 'glass' ? '#a9a4ad' : isCobble(d) ? '#b9a98f' : d === 'A' ? '#a8a8a2' : '#b8845c';
      g.fillRect(px, py, T, T);
      g.fillStyle = 'rgba(0,0,0,.13)';
      for (let row = 0; row < 4; row++) {
        g.fillRect(px, py + row * 8 + 7, T, 1);
        const o = (row % 2) * 8;
        for (let c = 0; c < 2; c++) g.fillRect(px + o + c * 16, py + row * 8, 1, 8);
      }
      break;
    }
    case TILE.WATER: {
      g.fillStyle = CITY.id === 'bogota' && d === 'S' ? '#3f7f86' : CITY.palms ? '#2f9fc4' : '#3779b0'; g.fillRect(px, py, T, T);
      g.fillStyle = 'rgba(255,255,255,.18)';
      g.fillRect(px + r * 16, py + 8, 10, 2); g.fillRect(px + 4 + (1 - r) * 14, py + 22, 8, 2);
      break;
    }
    case TILE.SAND: {
      g.fillStyle = '#e9d59a'; g.fillRect(px, py, T, T);
      g.fillStyle = '#d9c27f'; for (let k = 0; k < 4; k++) g.fillRect(px + h2(tx * 5 + k, ty) * 29, py + h2(tx, ty * 5 + k) * 29, 2, 2);
      break;
    }
    case TILE.RUNWAY: {
      g.fillStyle = '#2e3137'; g.fillRect(px, py, T, T);
      g.fillStyle = '#e9e9e9';
      if (tx === 9 && ty % 3 === 0) g.fillRect(px + 14, py + 4, 4, 22);
      if (tx === 7) g.fillRect(px + 3, py, 2, T);
      if (tx === 11) g.fillRect(px + T - 5, py, 2, T);
      if (ty === 40 || ty === 90) for (let k = 0; k < 4; k++) g.fillRect(px + 3 + k * 8, py + 4, 4, 24);
      break;
    }
    case TILE.APRON: {
      g.fillStyle = '#9b9b96'; g.fillRect(px, py, T, T);
      g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(px, py, T, 1); g.fillRect(px, py, 1, T);
      g.fillStyle = '#f2c94c';
      if (tx === 16 || tx === 20) g.fillRect(px + 15, py, 2, T);
      if (ty === 45 || ty === 84) g.fillRect(px, py + 15, T, 2);
      break;
    }
    default: g.fillStyle = '#333'; g.fillRect(px, py, T, T);
  }
}

function drawRoadTile(g, tx, ty, px, py, d) {
  const cob = isCobble(d);
  g.fillStyle = cob ? '#5f564c' : '#3a3d45';
  g.fillRect(px, py, T, T);
  if (cob) { // adoquines de La Candelaria
    g.fillStyle = '#6e6458';
    for (let yy = 0; yy < 4; yy++) for (let xx = 0; xx < 5; xx++) g.fillRect(px + xx * 8 + (yy % 2) * 4 - 4, py + yy * 8 + 1, 6, 6);
  } else {
    for (let k = 0; k < 4; k++) {
      g.fillStyle = k % 2 ? '#454952' : '#31343a';
      g.fillRect(px + h2(tx * 7 + k, ty) * 30, py + h2(tx, ty * 7 + k) * 30, 2, 2);
    }
  }
  const lx = tx % P, ly = ty % P;
  if (lx < RW && ly < RW) return; // intersección
  const horiz = ly < RW;
  const along = horiz ? lx : ly, across = horiz ? ly : lx;
  const troncal = horiz ? Math.floor(ty / P) === 6 : Math.floor(tx / P) === 4;
  // Cebras junto a las intersecciones
  if (along === RW || along === P - 1) {
    g.fillStyle = 'rgba(236,236,226,.85)';
    for (let k = 0; k < 4; k++) horiz ? g.fillRect(px + 4, py + 2 + k * 8, 24, 4) : g.fillRect(px + 2 + k * 8, py + 4, 4, 24);
    return;
  }
  if (across === 1) {
    if (troncal) { // carril exclusivo de TransMilenio
      g.fillStyle = CITY.troncal.lane;
      horiz ? g.fillRect(px, py + 2, T, T - 4) : g.fillRect(px + 2, py, T - 4, T);
      g.fillStyle = '#e8e2c8';
      if (horiz) { g.fillRect(px, py + 2, T, 2); g.fillRect(px, py + T - 4, T, 2); }
      else { g.fillRect(px + 2, py, 2, T); g.fillRect(px + T - 4, py, 2, T); }
    } else if (along % 2 === 0) {
      g.fillStyle = '#e0c860';
      horiz ? g.fillRect(px + 4, py + 15, 24, 2) : g.fillRect(px + 15, py + 4, 2, 24);
    }
  }
  g.fillStyle = 'rgba(255,255,255,.2)';
  if (across === 0) horiz ? g.fillRect(px, py + 4, T, 1) : g.fillRect(px + 4, py, 1, T);
  if (across === 2) horiz ? g.fillRect(px, py + T - 5, T, 1) : g.fillRect(px + T - 5, py, 1, T);
}

function drawCourt(g, c) {
  g.fillStyle = '#3d8b5a'; g.fillRect(c.x + 3, c.y + 3, c.w - 6, c.h - 6);
  g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 2;
  g.strokeRect(c.x + 7, c.y + 7, c.w - 14, c.h - 14);
  g.beginPath();
  if (c.w > c.h) { g.moveTo(c.x + c.w / 2, c.y + 7); g.lineTo(c.x + c.w / 2, c.y + c.h - 7); }
  else { g.moveTo(c.x + 7, c.y + c.h / 2); g.lineTo(c.x + c.w - 7, c.y + c.h / 2); }
  g.stroke();
  g.beginPath(); g.arc(c.x + c.w / 2, c.y + c.h / 2, 10, 0, TAU); g.stroke();
}

function drawParkingLot(g, l) {
  g.fillStyle = '#62656c'; g.fillRect(l.x + 2, l.y + 2, l.w - 4, l.h - 4);
  g.fillStyle = 'rgba(255,255,255,.65)';
  for (let x = l.x + T; x < l.x + l.w - 4; x += T) g.fillRect(x - 1, l.y + 6, 2, l.h - 12);
}

function drawPothole(g, p) {
  g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.ellipse(p.x, p.y, p.r * 1.3, p.r, 0, 0, TAU); g.fill();
  g.fillStyle = 'rgba(90,85,80,.6)'; g.beginPath(); g.ellipse(p.x - 1, p.y - 1, p.r * 0.8, p.r * 0.55, 0, 0, TAU); g.fill();
}

function drawReeds(g, r) {
  g.strokeStyle = '#6a8f3a'; g.lineWidth = 1.5;
  for (let k = -1; k <= 1; k++) { g.beginPath(); g.moveTo(r.x + k * 3, r.y); g.lineTo(r.x + k * 4, r.y - 9); g.stroke(); }
}

function drawBuildingShadow(g, b) {
  const sw = Math.min(18, 4 + b.height * 0.3);
  g.fillStyle = 'rgba(0,0,0,.26)';
  g.fillRect(b.x + b.w, b.y - b.lift + 6, sw, b.h);
}

function drawBuildingWall(g, b) {
  g.fillStyle = b.wallDark; g.fillRect(b.x, b.y, b.w, b.h);
  const fy = b.y + b.h - b.lift;
  g.fillStyle = b.wall; g.fillRect(b.x, fy, b.w, b.lift);
  const colonial = b.kind === 'tejas';
  if (b.lift >= 7) {
    const rows = Math.max(1, Math.floor((b.lift - 2) / 7));
    for (let r = 0; r < rows; r++) {
      const wy = fy + 2 + r * 7;
      for (let wx = b.x + 3; wx < b.x + b.w - 5; wx += 8) {
        g.fillStyle = colonial ? '#5d4037' : (h2(wx, wy) < 0.22 ? '#ffe9a8' : 'rgba(25,35,52,.85)');
        g.fillRect(wx, wy, 4, 4);
      }
    }
  }
  if (b.graffiti && b.lift >= 5) { // murales de colores
    const R = mulberry32(b.seed + 3);
    for (let k = 0; k < Math.max(2, b.w / 14); k++) {
      g.fillStyle = pickR(R, ['#ff1744', '#ffea00', '#00e5ff', '#76ff03', '#d500f9', '#ff9100', '#ffffff']);
      g.beginPath(); g.ellipse(b.x + R() * b.w, fy + R() * b.lift, 3 + R() * 6, 2 + R() * 3, R() * 3, 0, TAU); g.fill();
    }
  }
  if (b.balcony && b.lift >= 8) { // balcones de madera
    for (let bx = b.x + 4; bx < b.x + b.w - 14; bx += 22) {
      g.fillStyle = '#5d4037'; g.fillRect(bx, fy + 1, 14, 4);
      g.fillStyle = '#8d6e63'; for (let k = 0; k < 14; k += 3) g.fillRect(bx + k, fy + 1, 1, 4);
    }
  }
  g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(b.x, b.y + b.h - 2, b.w, 2);
}

/** Techos: se dibujan encima de las entidades para dar sensación de altura. */
function drawRoof(g, b, time) {
  const x = b.x, y = b.y - b.lift, w = b.w, h = b.h;
  g.fillStyle = b.roof; g.fillRect(x, y, w, h);
  const R = mulberry32(b.seed);
  switch (b.kind) {
    case 'tejas': {
      g.fillStyle = b.roofDark;
      for (let yy = y + 4; yy < y + h - 1; yy += 5) g.fillRect(x + 1, yy, w - 2, 1);
      g.fillStyle = b.roofLight;
      if (w >= h) g.fillRect(x + 1, y + (h >> 1) - 1, w - 2, 3); else g.fillRect(x + (w >> 1) - 1, y + 1, 3, h - 2);
      if (b.patio) {
        const px = x + w * 0.3, py = y + h * 0.3, pw = w * 0.4, ph = h * 0.4;
        g.fillStyle = '#d7c7a8'; g.fillRect(px - 3, py - 3, pw + 6, ph + 6);
        g.fillStyle = '#6fa356'; g.fillRect(px, py, pw, ph);
        g.fillStyle = '#3f7f35'; circ(g, px + pw / 2, py + ph / 2, Math.min(pw, ph) * 0.28);
      }
      break;
    }
    case 'tanks': {
      g.fillStyle = b.roofDark;
      for (let xx = x + 3; xx < x + w - 1; xx += 4) g.fillRect(xx, y + 1, 1, h - 2);
      const tx = x + 7 + R() * Math.max(1, w - 16), ty = y + 7 + R() * Math.max(1, h - 16);
      g.fillStyle = '#1d1d1f'; circ(g, tx, ty, 5.5);
      g.fillStyle = '#3d3d42'; circ(g, tx - 1, ty - 1, 3);
      if (R() < 0.55 && w > 40) {
        g.fillStyle = '#ddd'; g.fillRect(x + 4, y + h - 11, w - 8, 1);
        for (let k = 0; k < 4; k++) {
          g.fillStyle = pickR(R, ['#e53935', '#1e88e5', '#fdd835', '#ffffff', '#43a047', '#ec407a']);
          g.fillRect(x + 6 + k * ((w - 16) / 4), y + h - 11, 5, 6);
        }
      }
      break;
    }
    case 'terrace': {
      g.fillStyle = b.roofLight; g.fillRect(x + 3, y + 3, w - 6, h - 6);
      g.fillStyle = b.roof; g.fillRect(x + 5, y + 5, w - 10, h - 10);
      const dw = Math.min(34, w * 0.42), dh = Math.min(26, h * 0.36);
      g.fillStyle = '#a1887f'; g.fillRect(x + 7, y + 7, dw, dh);
      g.fillStyle = '#8d6e63'; for (let k = y + 10; k < y + 7 + dh; k += 4) g.fillRect(x + 7, k, dw, 1);
      g.fillStyle = '#4caf50'; for (let k = 0; k < 4; k++) circ(g, x + 9 + R() * (w - 18), y + 9 + R() * (h - 18), 3);
      g.fillStyle = '#90caf9'; g.fillRect(x + w - 17, y + h - 15, 9, 7);
      break;
    }
    case 'ac': {
      const n = 2 + Math.floor(R() * 4);
      for (let k = 0; k < n; k++) {
        const ax = x + 6 + R() * Math.max(1, w - 22), ay = y + 6 + R() * Math.max(1, h - 20);
        g.fillStyle = '#c9ccd1'; g.fillRect(ax, ay, 11, 9);
        g.fillStyle = '#555'; circ(g, ax + 5.5, ay + 4.5, 2.6);
      }
      if (w >= 128 && h >= 128 && R() < 0.6) {
        g.strokeStyle = '#f5f5f5'; g.lineWidth = 2;
        g.beginPath(); g.arc(x + w / 2, y + h / 2, 18, 0, TAU); g.stroke();
        g.fillStyle = '#f5f5f5'; g.font = 'bold 18px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('H', x + w / 2, y + h / 2 + 1);
      }
      break;
    }
    case 'glass': {
      g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
      g.fillStyle = 'rgba(150,220,255,.11)';
      for (let k = -h; k < w; k += 24) { g.beginPath(); g.moveTo(x + k, y + h); g.lineTo(x + k + 10, y + h); g.lineTo(x + k + 10 + h, y); g.lineTo(x + k + h, y); g.closePath(); g.fill(); }
      g.restore();
      g.strokeStyle = b.neon; g.globalAlpha = 0.6; g.lineWidth = 2; g.strokeRect(x + 3, y + 3, w - 6, h - 6); g.globalAlpha = 1;
      break;
    }
    case 'tower': {
      for (let s = 0; s < 3; s++) {
        const ins = 8 + s * 12;
        if (w - ins * 2 < 10) break;
        g.fillStyle = s % 2 ? b.roofDark : b.roofLight; g.fillRect(x + ins, y + ins, w - ins * 2, h - ins * 2);
      }
      g.fillStyle = (time % 1.4) < 0.7 ? '#ff1744' : '#5a0010'; circ(g, x + w / 2, y + h / 2, 4);
      break;
    }
    case 'terminal': {
      g.fillStyle = b.roofDark; for (let yy = y + 8; yy < y + h; yy += 16) g.fillRect(x + 2, yy, w - 4, 2);
      g.fillStyle = '#7fb3d5'; for (let yy = y + 14; yy < y + h - 8; yy += 32) g.fillRect(x + 12, yy, w - 24, 6);
      g.save(); g.translate(x + w / 2, y + h / 2); g.rotate(-Math.PI / 2);
      g.fillStyle = '#37474f'; g.font = 'bold 26px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(CITY.airport.toUpperCase(), 0, 0); g.restore();
      break;
    }
    case 'hangar': {
      g.fillStyle = b.roofLight; for (let xx = x + 6; xx < x + w; xx += 12) g.fillRect(xx, y + 2, 3, h - 4);
      break;
    }
    case 'cathedral': {
      g.fillStyle = b.roofDark; g.fillRect(x + 30, y + 10, w - 60, h - 20);
      g.fillStyle = '#9e9a92'; g.fillRect(x + 4, y + h - 36, 30, 32); g.fillRect(x + w - 34, y + h - 36, 30, 32);
      g.fillStyle = '#6d6a64'; circ(g, x + 19, y + h - 20, 8); circ(g, x + w - 19, y + h - 20, 8);
      g.fillStyle = '#f5f0e0'; g.fillRect(x + w / 2 - 2, y + 18, 4, 26); g.fillRect(x + w / 2 - 10, y + 26, 20, 4);
      break;
    }
    case 'capitol': {
      g.fillStyle = b.roofLight; for (let xx = x + 6; xx < x + w - 4; xx += 10) g.fillRect(xx, y + 4, 4, h - 8);
      break;
    }
    case 'wall': { // piedra de las murallas con almenas
      g.fillStyle = b.roofDark;
      for (let yy = y + 5; yy < y + h; yy += 6) for (let xx = x + ((yy / 6) % 2) * 5; xx < x + w; xx += 10) g.fillRect(xx, yy, 1, 6);
      for (let yy = y + 5; yy < y + h; yy += 6) g.fillRect(x, yy, w, 1);
      g.fillStyle = b.roofLight; for (let xx = x + 2; xx < x + w - 4; xx += 10) g.fillRect(xx, y + 1, 6, 4);
      break;
    }
    case 'reloj': { // Torre del Reloj
      g.fillStyle = '#f6d365'; g.fillRect(x + 10, y + 10, w - 20, h - 20);
      g.fillStyle = '#c62828'; g.fillRect(x + w / 2 - 8, y + 6, 16, 10);
      g.fillStyle = '#fff'; circ(g, x + w / 2, y + h / 2 + 4, 13);
      g.strokeStyle = '#333'; g.lineWidth = 2; g.beginPath();
      g.moveTo(x + w / 2, y + h / 2 + 4); g.lineTo(x + w / 2, y + h / 2 - 6);
      g.moveTo(x + w / 2, y + h / 2 + 4); g.lineTo(x + w / 2 + 7, y + h / 2 + 4); g.stroke();
      break;
    }
    case 'castillo': { // Castillo San Felipe: terrazas escalonadas y bandera
      for (let s2 = 0; s2 < 4; s2++) { const ins = 6 + s2 * 18; if (w - ins * 2 < 20) break; g.fillStyle = s2 % 2 ? b.roofDark : b.roofLight; g.fillRect(x + ins, y + ins, w - ins * 2, h - ins * 2); }
      const fx = x + w / 2, fy = y + h / 2;
      g.fillStyle = '#5d4037'; g.fillRect(fx - 1, fy - 20, 2, 22);
      g.fillStyle = '#fcd116'; g.fillRect(fx + 1, fy - 20, 16, 5); g.fillStyle = '#003893'; g.fillRect(fx + 1, fy - 15, 16, 3); g.fillStyle = '#ce1126'; g.fillRect(fx + 1, fy - 12, 16, 3);
      break;
    }
    case 'botero': { // escultura gordita de bronce
      g.fillStyle = 'rgba(0,0,0,.25)'; circ(g, x + w / 2 + 3, y + h / 2 + 3, 12);
      g.fillStyle = '#4e342e'; circ(g, x + w / 2, y + h / 2 + 2, 12);
      g.fillStyle = '#795548'; circ(g, x + w / 2 - 3, y + h / 2 - 1, 7);
      g.fillStyle = '#6d4c41'; circ(g, x + w / 2, y + h / 2 - 9, 5);
      return;
    }
    case 'gato': { // El Gato del Río
      const cx = x + w / 2, cy = y + h / 2;
      g.fillStyle = '#3e2723'; circ(g, cx, cy + 6, 16); circ(g, cx, cy - 12, 11);
      g.beginPath(); g.moveTo(cx - 10, cy - 18); g.lineTo(cx - 6, cy - 30); g.lineTo(cx - 1, cy - 20); g.fill();
      g.beginPath(); g.moveTo(cx + 10, cy - 18); g.lineTo(cx + 6, cy - 30); g.lineTo(cx + 1, cy - 20); g.fill();
      g.fillStyle = '#ffd54f'; circ(g, cx - 4, cy - 13, 2); circ(g, cx + 4, cy - 13, 2);
      g.strokeStyle = '#3e2723'; g.lineWidth = 4; g.beginPath(); g.moveTo(cx + 14, cy + 12); g.quadraticCurveTo(cx + 28, cy + 10, cx + 24, cy - 6); g.stroke();
      return;
    }
    case 'statue': {
      g.fillStyle = '#7d7668'; circ(g, x + w / 2, y + h / 2, 9);
      g.fillStyle = '#4e5a4a'; circ(g, x + w / 2, y + h / 2 - 2, 5);
      break;
    }
  }
  g.strokeStyle = b.roofDark; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, w - 2, h - 2);
  g.fillStyle = 'rgba(255,255,255,.14)'; g.fillRect(x + 2, y + 2, w - 4, 2);
  if (b.balcony) { // buganvilias
    const R2 = mulberry32(b.seed + 9);
    for (let k = 0; k < w / 9; k++) { g.fillStyle = R2() < 0.5 ? '#e91e63' : '#f06292'; circ(g, x + R2() * w, y + h - 2 - R2() * 5, 2.4); }
  }
}

function drawTreeCanopy(g, t) {
  if (t.palm) { // palmera: hojas en estrella
    g.fillStyle = 'rgba(0,0,0,.22)'; circ(g, t.x + 5, t.y + 6, t.r * 0.8);
    const R = t.r * 1.15;
    for (let k = 0; k < 7; k++) {
      const a = k * 0.9 + t.x * 0.01;
      g.strokeStyle = k % 2 ? '#3f9a3a' : '#56b04a'; g.lineWidth = 5; g.lineCap = 'round';
      g.beginPath(); g.moveTo(t.x, t.y); g.quadraticCurveTo(t.x + Math.cos(a) * R * 0.7, t.y + Math.sin(a) * R * 0.7 - 3, t.x + Math.cos(a) * R, t.y + Math.sin(a) * R); g.stroke();
    }
    g.lineCap = 'butt';
    g.fillStyle = '#8d6e63'; circ(g, t.x, t.y, 3.5);
    g.fillStyle = '#795548'; circ(g, t.x + 2, t.y + 1, 1.8);
    return;
  }
  g.fillStyle = 'rgba(0,0,0,.24)'; circ(g, t.x + 4, t.y + 5, t.r);
  g.fillStyle = t.c; circ(g, t.x, t.y, t.r);
  g.fillStyle = t.c2; circ(g, t.x - t.r * 0.3, t.y - t.r * 0.3, t.r * 0.55);
}

function drawStall(g, s) {
  g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(s.x - 22, s.y - 12, 48, 30);
  for (let k = 0; k < 6; k++) { g.fillStyle = k % 2 ? '#fafafa' : s.c; g.fillRect(s.x - 24 + k * 8, s.y - 16, 8, 28); }
}

/** Paradero de TransMilenio (techo rojo sobre el andén). */
function drawStation(g, st) {
  g.save(); g.translate(st.x, st.y);
  if (st.axis === 'v') g.rotate(Math.PI / 2);
  g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(-62, -6, 128, 18);
  g.fillStyle = '#b0bec5'; g.fillRect(-64, -10, 128, 18);
  g.fillStyle = CITY.troncal.color; g.fillRect(-64, -10, 128, 7);
  g.fillStyle = '#fff'; g.fillRect(-64, -3, 128, 2);
  g.fillStyle = 'rgba(160,220,255,.5)'; for (let k = -56; k < 60; k += 16) g.fillRect(k, 0, 10, 6);
  g.fillStyle = '#fff'; g.font = 'bold 9px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(CITY.troncal.short, 0, -6);
  g.restore();
}

/** Toldo de colores frente a cada negocio. */
function drawAwning(g, p) {
  if (p.type === 'giver' || p.type === 'hide' || p.type === 'atm' || p.type === 'station' || p.type === 'airport') return;
  let x, y, w, h;
  switch (p.side) {
    case 'N': x = p.x - 16; y = p.y + 10; w = 32; h = 8; break;
    case 'S': x = p.x - 16; y = p.y - 18; w = 32; h = 8; break;
    case 'W': x = p.x + 10; y = p.y - 16; w = 8; h = 32; break;
    default: x = p.x - 18; y = p.y - 16; w = 8; h = 32;
  }
  const n = 4;
  for (let k = 0; k < n; k++) {
    g.fillStyle = k % 2 ? '#fafafa' : p.color;
    if (w > h) g.fillRect(x + k * w / n, y, w / n, h); else g.fillRect(x, y + k * h / n, w, h / n);
  }
}

// ==========================================================================
// 7. ENTIDADES
// ==========================================================================
const SKINS = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#d4a373'];
const HAIRS = ['#2b1b0e', '#4a2c17', '#0f0f0f', '#6b4423', '#9e9e9e', '#3b2416'];
const SHIRTS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#fb8c00', '#00897b', '#f06292', '#ffffff', '#455a64', '#6d4c41', '#3949ab'];
const PANTS = ['#263238', '#37474f', '#1a237e', '#3e2723', '#212121', '#5d4037'];
const UMBRELLAS = ['#e53935', '#1e88e5', '#212121', '#fdd835', '#8e24aa', '#43a047'];
function randomLook() {
  return { skin: pick(SKINS), hair: pick(HAIRS), shirt: pick(SHIRTS), pants: pick(PANTS), ruana: Math.random() < 0.06 };
}

let VID = 1;
class Vehicle {
  constructor(type, x, y, angle, o = {}) {
    this.id = VID++; this.type = type; this.spec = VEH[type];
    this.x = x; this.y = y; this.angle = angle; this.vx = 0; this.vy = 0; this.speed = 0;
    this.hp = o.hp != null ? o.hp : this.spec.hp;
    this.setColor(o.color || defaultColor(type));
    this.mode = o.mode || 'traffic';                     // traffic | physics
    this.driver = o.driver !== undefined ? o.driver : (this.mode === 'traffic' ? 'npc' : null); // npc | player | cop | null
    this.dir = 0; this.ni = 0; this.nj = 0; this.plan = null;
    this.cruise = (type === 'bus' ? 105 : type === 'tm' ? 150 : type === 'moto' ? 165 : 128) * rand(0.85, 1.15);
    this.stopT = 0; this.jamT = 0; this.honkT = rand(2, 6); this.blockedT = 0; this.potCD = 0;
    this.owned = !!o.owned; this.stolen = false; this.persist = !!o.persist; this.mission = !!o.mission;
    this.siren = false; this.wrecked = false; this.stuckT = 0; this.reverseT = 0;
    this.rider = o.rider || randomLook();
    this.lastStation = null; this.chase = false; this.wp = null; this.officerOut = false;
  }
  setColor(c) { this.color = c; this.colorL = shade(c, 0.28); this.colorD = shade(c, -0.3); }
}
const NOCTL = { throttle: 0, steer: 0, brake: 1 };
const VEH_PTS = [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1], [0.5, 1], [0.5, -1], [-0.5, 1], [-0.5, -1]];

function vehCircles(v) {
  const c = Math.cos(v.angle), s = Math.sin(v.angle), L = v.spec.len, r = v.spec.w / 2 + 1;
  if (L > 40) return [-L / 3, 0, L / 3].map(o => [v.x + c * o, v.y + s * o, r]);
  return [[v.x - c * L / 4, v.y - s * L / 4, r], [v.x + c * L / 4, v.y + s * L / 4, r]];
}
/** Velocidad en el mundo (el tráfico no guarda vx/vy). */
function vehVel(v) { return v.mode === 'traffic' ? [DIRV[v.dir][0] * v.speed, DIRV[v.dir][1] * v.speed] : [v.vx, v.vy]; }

function vehicleBlocked(v, x, y, a) {
  const c = Math.cos(a), s = Math.sin(a), hl = v.spec.len / 2, hw = v.spec.w / 2;
  for (const pt of VEH_PTS) {
    const lx = pt[0] * hl, ly = pt[1] * hw;
    if (solidAt(x + lx * c - ly * s, y + lx * s + ly * c)) return true;
  }
  if (v.driver === 'player') {
    const d = lockDistrictAt(x, y);
    if (!districtUnlocked(d)) { G.lockHint = d; return true; }
  }
  return false;
}

/** Mueve un vehículo con colisión contra el mapa. Devuelve la velocidad del impacto. */
function moveVehicle(v, dt, na) {
  const nx = v.x + v.vx * dt, ny = v.y + v.vy * dt;
  if (vehicleBlocked(v, v.x, v.y, v.angle)) { v.x = nx; v.y = ny; v.angle = na; return 0; } // atrapado: dejarlo salir
  if (!vehicleBlocked(v, v.x, v.y, na)) v.angle = na; else { v.vx *= 0.92; v.vy *= 0.92; }
  if (!vehicleBlocked(v, nx, ny, v.angle)) { v.x = nx; v.y = ny; return 0; }
  if (!vehicleBlocked(v, nx, v.y, v.angle)) { v.x = nx; const imp = Math.abs(v.vy); v.vy *= -0.25; v.vx *= 0.85; return imp; }
  if (!vehicleBlocked(v, v.x, ny, v.angle)) { v.y = ny; const imp = Math.abs(v.vx); v.vx *= -0.25; v.vy *= 0.85; return imp; }
  const imp = Math.hypot(v.vx, v.vy); v.vx *= -0.3; v.vy *= -0.3; return imp;
}

/** Física arcade: aceleración, giro dependiente de la velocidad y derrape lateral. */
function updatePhysicsVehicle(v, dt, ctl) {
  const s = v.spec;
  if (v.hp <= 0 && !v.wrecked) {
    v.wrecked = true; v.siren = false;
    for (let k = 0; k < 14; k++) addFx('smoke', v.x, v.y, rand(-30, 30), rand(-30, 30), rand(1, 2));
    if (v === G.player.vehicle) { notify('💥 Vehículo varado', 'Se murió el motor. Bájate con F y busca otro.', '#ff5252'); Sound.sfx('crash'); }
  }
  if (v.wrecked) ctl = NOCTL;
  const fx = Math.cos(v.angle), fy = Math.sin(v.angle), rx = -fy, ry = fx;
  let fwd = v.vx * fx + v.vy * fy, lat = v.vx * rx + v.vy * ry;
  const tl = tileAtPx(v.x, v.y);
  const offroad = tl === TILE.GRASS || tl === TILE.TREE;
  let maxF = s.max * (v.hp < s.hp * 0.3 ? 0.7 : 1) * (offroad ? 0.55 : 1);
  if (v.driver === 'player' && !s.engine && G.player.energy < 10) maxF *= 0.6;
  const th = ctl.throttle;
  if (th > 0) {
    if (fwd < -5) fwd += s.acc * 2.2 * th * dt;
    else if (fwd < maxF) fwd = Math.min(maxF, fwd + s.acc * th * dt * (1 - 0.45 * fwd / maxF));
    else fwd = approach(fwd, maxF, 300 * dt);
  } else if (th < 0) {
    if (fwd > 5) fwd -= s.acc * 2.2 * -th * dt;
    else fwd = Math.max(-maxF * 0.38, fwd - s.acc * 0.7 * -th * dt);
  } else fwd = approach(fwd, 0, (55 + Math.abs(fwd) * 0.5) * dt);
  if (ctl.brake) fwd = approach(fwd, 0, 240 * dt);
  const sf = clamp(fwd / 110, -1, 1);
  const turn = s.turn * ctl.steer * sf * (ctl.brake ? 1.4 : 1);
  const grip = s.grip * (ctl.brake ? 0.22 : 1) * (1 - G.wetness * 0.55) * (offroad ? 0.8 : 1);
  lat *= Math.exp(-grip * dt);
  if (Math.abs(lat) > 65 && !s.two) addSkid(v);
  v.vx = fx * fwd + rx * lat; v.vy = fy * fwd + ry * lat;
  v.speed = fwd;
  const imp = moveVehicle(v, dt, v.angle + turn * dt);
  if (imp > 45) vehicleImpact(v, imp);
  if (v.potCD > 0) v.potCD -= dt;
  else if (Math.abs(fwd) > 110) checkPothole(v);
  if (v.hp < s.hp * 0.35 && Math.random() < dt * (v.wrecked ? 6 : 3)) addFx('smoke', v.x + fx * s.len * 0.35, v.y + fy * s.len * 0.35, rand(-10, 10), rand(-20, -5), rand(1, 1.8));
}

function vehicleImpact(v, imp) {
  const dmg = (imp - 45) * 0.11 / Math.sqrt(v.spec.mass);
  v.hp = Math.max(0, v.hp - dmg);
  for (let k = 0; k < Math.min(8, imp / 25); k++) addFx('spark', v.x + Math.cos(v.angle) * v.spec.len / 2, v.y + Math.sin(v.angle) * v.spec.len / 2, rand(-80, 80), rand(-80, 80), 0.4);
  if (v === G.player.vehicle) {
    shake(Math.min(12, imp / 25));
    Sound.sfx(imp > 120 ? 'crash' : 'bump');
    const hurt = (imp - 90) * (v.spec.two ? 0.12 : 0.03);
    if (hurt > 0) damagePlayer(hurt);
    if (G.mission && G.mission.onImpact) G.mission.onImpact(imp);
  }
}

function checkPothole(v) {
  const key = Math.floor(v.y / T) * MW + Math.floor(v.x / T);
  const ph = World.potholes.get(key);
  if (!ph || dist(ph.x, ph.y, v.x, v.y) > ph.r + 7) return;
  v.potCD = 0.7;
  v.hp = Math.max(0, v.hp - rand(2, 5) * (v.spec.two ? 1.4 : 1));
  v.vx *= 0.86; v.vy *= 0.86;
  if (v === G.player.vehicle) {
    shake(5); Sound.sfx('bump');
    floater(v.x, v.y - 20, '¡HUECO!', '#ffb74d');
    G.stats.potholes++;
    if (G.stats.potholes >= 25) unlock('pothole');
    if (G.mission && G.mission.onImpact) G.mission.onImpact(70, true);
  }
}

// ---------- Tráfico (sigue carriles e intersecciones) ----------
function randomTrafficType() {
  const r = Math.random();
  if (r < 0.37) return 'sedan';
  if (r < 0.61) return G.events.strike ? 'sedan' : 'taxi';
  if (r < 0.81) return 'moto';
  if (r < 0.88) return 'bus';
  if (r < 0.96) return 'suv';
  return 'police';
}

function spawnTrafficOn(e, dir, s, type) {
  const tm = type === 'tm';
  const x = e.h ? s : laneCoord(dir, e.i, tm), y = e.h ? laneCoord(dir, e.j, tm) : s;
  const v = new Vehicle(type, x, y, DIR_ANG[dir], { mode: 'traffic' });
  v.dir = dir;
  if (e.h) { v.nj = e.j; v.ni = dir === 0 ? e.i + 1 : e.i; } else { v.ni = e.i; v.nj = dir === 1 ? e.j + 1 : e.j; }
  if (type === 'tm') v.cruise = 160;
  G.vehicles.push(v);
  return v;
}

function spawnTraffic(type, minD = 520, maxD = 1300) {
  const f = G.focus, tm = type === 'tm';
  const near = World.edges.filter(e => {
    if (tm && !(e.h ? e.j === 6 : e.i === 4)) return false;
    const mx = e.h ? e.i * PT + 304 : e.i * PT + 48, my = e.h ? e.j * PT + 48 : e.j * PT + 304;
    const d = dist(mx, my, f.x, f.y);
    return d < maxD + 260 && d > minD - 260 && !World.closed.has((e.h ? 'h' : 'v') + e.i + ',' + e.j);
  });
  if (!near.length) return null;
  for (let tries = 0; tries < 10; tries++) {
    const e = pick(near);
    const dir = e.h ? (Math.random() < 0.5 ? 0 : 2) : (Math.random() < 0.5 ? 1 : 3);
    const base = e.h ? e.i * PT : e.j * PT;
    const s = rand(base + 112, base + PT - 24);
    const x = e.h ? s : laneCoord(dir, e.i, tm), y = e.h ? laneCoord(dir, e.j, tm) : s;
    const d = dist(x, y, f.x, f.y);
    if (d < minD || d > maxD || onScreen(x, y, 80)) continue;
    if (G.vehicles.some(o => Math.abs(o.x - x) < 70 && Math.abs(o.y - y) < 70)) continue;
    return spawnTrafficOn(e, dir, s, type || randomTrafficType());
  }
  return null;
}

/** Distancia al obstáculo más cercano delante (otros carros, peatones en la vía, barreras). */
function obstacleAhead(v, f) {
  let best = 999;
  const look = 95 + v.spec.len * 0.5;
  const check = (ox, oy, rad) => {
    const rx = ox - v.x, ry = oy - v.y;
    const along = rx * f[0] + ry * f[1];
    if (along <= 0 || along > look + rad) return;
    const lat = Math.abs(rx * f[1] - ry * f[0]);
    if (lat < 11 + rad * 0.6) best = Math.min(best, along - rad);
  };
  for (const o of G.vehicles) {
    if (o === v) continue;
    if (o.mode === 'traffic' && o.dir !== v.dir) continue;
    if (Math.abs(o.x - v.x) > 160 || Math.abs(o.y - v.y) > 160) continue;
    check(o.x, o.y, o.spec.len * 0.5);
  }
  const p = G.player;
  if (G.state === 'play' && p.onFoot && !p.hidden) check(p.x, p.y, 6);
  for (const pd of G.peds) if (pd.mode !== 'walk' && pd.mode !== 'gone') check(pd.x, pd.y, 6);
  const fx = v.x + f[0] * (v.spec.len * 0.5 + 18), fy = v.y + f[1] * (v.spec.len * 0.5 + 18);
  if (solidAt(fx, fy)) best = Math.min(best, 10);
  return best;
}

function updateTrafficCar(v, dt) {
  const tm = v.type === 'tm';
  let desired = v.cruise * G.trafficMul;
  if (v.jamT > 0) { v.jamT -= dt; desired = 0; }
  if (v.stopT > 0) { v.stopT -= dt; desired = 0; }
  // Retén: todos frenan al pasar
  const cp = G.events.checkpoint;
  if (cp && dist(v.x, v.y, cp.x, cp.y) < 110) desired = Math.min(desired, 45);
  const f = DIRV[v.dir];
  const gap = obstacleAhead(v, f);
  if (gap < 90) desired = Math.min(desired, Math.max(0, (gap - 14) * 2.4));
  // TransMilenio: para en las estaciones
  if (tm) for (const st of World.stations) {
    if (v.lastStation === st) continue;
    const onAxis = st.axis === 'h' ? (v.dir % 2 === 0 && Math.abs(v.y - (6 * PT + 48)) < 40) : (v.dir % 2 === 1 && Math.abs(v.x - (4 * PT + 48)) < 40);
    if (onAxis && (st.axis === 'h' ? Math.abs(v.x - st.x) : Math.abs(v.y - st.y)) < 6) { v.stopT = 2.5; v.lastStation = st; }
  }
  v.speed = approach(v.speed, desired, (desired < v.speed ? 420 : v.spec.acc * 0.6) * dt);
  // Pitos cuando el trancón no avanza
  if (v.speed < 5 && gap < 90) {
    v.blockedT += dt;
    if (v.blockedT > v.honkT) {
      v.blockedT = 0; v.honkT = rand(3, 7);
      if (dist(v.x, v.y, G.player.x, G.player.y) < 420) { Sound.sfx('horn'); if (Math.random() < 0.4) bubble(v, pick(CITY.honk)); }
    }
    // Calle bloqueada por barreras: media vuelta
    if (solidAt(v.x + f[0] * (v.spec.len * 0.5 + 18), v.y + f[1] * (v.spec.len * 0.5 + 18)) && v.blockedT > 2) uTurn(v);
  } else if (v.speed > 20) v.blockedT = 0;
  v.x += f[0] * v.speed * dt; v.y += f[1] * v.speed * dt;
  v.angle += angDiff(v.angle, DIR_ANG[v.dir]) * Math.min(1, dt * 9);
  handleTurn(v);
}

function uTurn(v) {
  const tm = v.type === 'tm';
  const nd = (v.dir + 2) % 4;
  v.ni -= DIRV[v.dir][0]; v.nj -= DIRV[v.dir][1];
  v.dir = nd; v.plan = null; v.blockedT = 0;
  if (nd % 2 === 0) v.y = laneCoord(nd, Math.round((v.y - 48) / PT), tm); else v.x = laneCoord(nd, Math.round((v.x - 48) / PT), tm);
  v.angle = DIR_ANG[nd];
}

/** Decide y ejecuta los giros en las intersecciones. */
function handleTurn(v) {
  const tm = v.type === 'tm';
  const c = nodeCenter(v.ni, v.nj);
  const toNode = v.dir === 0 ? c[0] - v.x : v.dir === 2 ? v.x - c[0] : v.dir === 1 ? c[1] - v.y : v.y - c[1];
  if (!v.plan && toNode < 130) {
    let exits = nodeExits(v.ni, v.nj).filter(d => d !== (v.dir + 2) % 4);
    if (tm) exits = exits.filter(d => isTroncalEdge(v.ni, v.nj, d));
    if (!exits.length) exits = [(v.dir + 2) % 4];
    let nd = exits.includes(v.dir) && Math.random() < 0.55 ? v.dir : pick(exits);
    if (v.route) { const r = v.route(v.ni, v.nj, exits); if (r != null) nd = r; }
    let tp;
    if (nd === v.dir || nd === (v.dir + 2) % 4) tp = v.dir % 2 === 0 ? c[0] : c[1];
    else tp = laneCoord(nd, nd % 2 === 1 ? v.ni : v.nj, tm);
    v.plan = { nd, tp };
  }
  if (!v.plan) return;
  const pos = v.dir % 2 === 0 ? v.x : v.y;
  const passed = v.dir === 0 || v.dir === 1 ? pos >= v.plan.tp : pos <= v.plan.tp;
  if (!passed) return;
  const nd = v.plan.nd;
  if (v.dir % 2 === 0) v.x = v.plan.tp; else v.y = v.plan.tp;
  v.dir = nd;
  if (nd % 2 === 0) v.y = laneCoord(nd, v.nj, tm); else v.x = laneCoord(nd, v.ni, tm);
  v.ni += DIRV[nd][0]; v.nj += DIRV[nd][1];
  v.plan = null;
}

// ---------- Colisiones entre vehículos ----------
function collideVehicles() {
  const vs = G.vehicles;
  for (let a = 0; a < vs.length; a++) {
    const A = vs[a];
    for (let b = a + 1; b < vs.length; b++) {
      const B = vs[b];
      if (A.mode !== 'physics' && B.mode !== 'physics') continue;
      if (Math.abs(A.x - B.x) > 110 || Math.abs(A.y - B.y) > 110) continue;
      // Las patrullas atraviesan el tráfico para no quedarse atascadas
      if (((A.driver === 'cop' || A.driver === 'racer') && B.mode === 'traffic') || ((B.driver === 'cop' || B.driver === 'racer') && A.mode === 'traffic')) continue;
      const CA = vehCircles(A), CB = vehCircles(B);
      let pen = 0, nx = 0, ny = 0;
      for (const ca of CA) for (const cb of CB) {
        const dx = cb[0] - ca[0], dy = cb[1] - ca[1], d = Math.hypot(dx, dy) || 0.01, p = ca[2] + cb[2] - d;
        if (p > pen) { pen = p; nx = dx / d; ny = dy / d; }
      }
      if (pen <= 0) continue;
      const ma = A.mode === 'physics' ? A.spec.mass : 1000, mb = B.mode === 'physics' ? B.spec.mass : 1000, tot = ma + mb;
      if (A.mode === 'physics') { const ox = A.x, oy = A.y; A.x -= nx * pen * mb / tot; A.y -= ny * pen * mb / tot; if (vehicleBlocked(A, A.x, A.y, A.angle)) { A.x = ox; A.y = oy; } }
      if (B.mode === 'physics') { const ox = B.x, oy = B.y; B.x += nx * pen * ma / tot; B.y += ny * pen * ma / tot; if (vehicleBlocked(B, B.x, B.y, B.angle)) { B.x = ox; B.y = oy; } }
      const [avx, avy] = vehVel(A), [bvx, bvy] = vehVel(B);
      const rvn = (bvx - avx) * nx + (bvy - avy) * ny;
      if (rvn >= 0) continue;
      const j = -(1.3 * rvn) / (1 / ma + 1 / mb);
      if (A.mode === 'physics') { A.vx -= j * nx / ma; A.vy -= j * ny / ma; }
      if (B.mode === 'physics') { B.vx += j * nx / mb; B.vy += j * ny / mb; }
      const imp = -rvn;
      if (A.mode === 'traffic') A.stopT = Math.max(A.stopT, 1.5);
      if (B.mode === 'traffic') B.stopT = Math.max(B.stopT, 1.5);
      if (imp > 40) {
        A.hp = Math.max(0, A.hp - (imp - 40) * 0.07 * mb / tot / Math.sqrt(A.spec.mass) * (A.mode === 'traffic' ? 0 : 1));
        B.hp = Math.max(0, B.hp - (imp - 40) * 0.07 * ma / tot / Math.sqrt(B.spec.mass) * (B.mode === 'traffic' ? 0 : 1));
        const pv = G.player.vehicle;
        if (pv === A || pv === B) {
          const other = pv === A ? B : A;
          shake(Math.min(10, imp / 25)); Sound.sfx(imp > 110 ? 'crash' : 'bump');
          addFx('spark', (A.x + B.x) / 2, (A.y + B.y) / 2, rand(-60, 60), rand(-60, 60), 0.4);
          if (pv.spec.two && imp > 100) damagePlayer((imp - 100) * 0.1);
          if (G.mission && G.mission.onImpact) G.mission.onImpact(imp);
          if (other.type === 'police' && imp > 70 && other.driver !== null) addWanted(1, 'Le pegaste a una patrulla');
          if (other.mode === 'traffic' && Math.random() < 0.5) bubble(other, pick(['¡Ey, qué le pasa!', '¡Mire por dónde va!', '¡Me rayó el carro!']));
        }
      }
    }
  }
}

// ---------- Peatones ----------
function ringPos(bi, bj, d, off) {
  const x0 = (bi * P + RW + 0.5) * T, y0 = (bj * P + RW + 0.5) * T, L = 12 * T, per = 4 * L;
  d = ((d % per) + per) % per;
  const seg = Math.floor(d / L), u = d - seg * L;
  switch (seg) {
    case 0: return [x0 + u, y0 + off, 0];
    case 1: return [x0 + L - off, y0 + u, Math.PI / 2];
    case 2: return [x0 + L - u, y0 + L - off, Math.PI];
    default: return [x0 + off, y0 + L - u, -Math.PI / 2];
  }
}

class Ped {
  constructor(o) {
    this.mode = 'walk'; this.t = 0; this.anim = Math.random() * 10; this.alpha = 1; this.idle = 0;
    this.look = o.look || randomLook(); this.speed = rand(28, 46);
    this.umbrella = Math.random() < 0.65 ? pick(UMBRELLAS) : null;
    this.x = 0; this.y = 0; this.angle = 0;
    if (o.bi != null) {
      this.bi = o.bi; this.bj = o.bj; this.d = o.d; this.off = rand(-7, 7); this.dirS = Math.random() < 0.5 ? 1 : -1;
      this.place();
    } else { this.x = o.x; this.y = o.y; this.mode = o.mode || 'static'; this.angle = o.angle || 0; }
  }
  place() {
    const p = ringPos(this.bi, this.bj, this.d, this.off);
    this.x = p[0]; this.y = p[1]; this.angle = p[2] + (this.dirS < 0 ? Math.PI : 0);
  }
}

function circleFree(x, y, r) {
  return !(solidAt(x - r, y - r) || solidAt(x + r, y - r) || solidAt(x - r, y + r) || solidAt(x + r, y + r));
}
/** Mueve una entidad circular con deslizamiento contra paredes. */
function moveCircle(e, dx, dy, r, isPlayer) {
  const ok = (x, y) => {
    if (!circleFree(x, y, r)) return false;
    if (isPlayer) { const d = lockDistrictAt(x, y); if (!districtUnlocked(d)) { G.lockHint = d; return false; } }
    return true;
  };
  if (ok(e.x + dx, e.y)) e.x += dx;
  if (ok(e.x, e.y + dy)) e.y += dy;
}

function scarePed(p, fx, fy, t = 3) {
  if (p.mode !== 'walk' && p.mode !== 'static') return;
  if (p.keep) return;
  p.mode = 'flee'; p.fleeT = t; p.fx = fx; p.fy = fy; p.speed = rand(95, 125);
  if (Math.random() < 0.3) bubble(p, pick(['¡Ay, Dios mío!', '¡Uy, cuidado!', '¡Corran!', '¡Qué peligro!']));
}

function updatePed(p, dt) {
  p.t += dt;
  switch (p.mode) {
    case 'walk': {
      if (p.idle > 0) { p.idle -= dt; break; }
      p.d += p.dirS * p.speed * dt; p.place(); p.anim += dt * p.speed * 0.15;
      if (Math.random() < dt * 0.04) p.idle = rand(1, 3);
      if (Math.random() < dt * 0.015) p.dirS *= -1;
      break;
    }
    case 'flee': {
      const dx = p.x - p.fx, dy = p.y - p.fy, l = Math.hypot(dx, dy) || 1;
      moveCircle(p, dx / l * p.speed * dt, dy / l * p.speed * dt, 5);
      p.angle = Math.atan2(dy, dx); p.anim += dt * p.speed * 0.15;
      p.fleeT -= dt;
      if (p.fleeT <= 0) p.mode = 'gone';
      break;
    }
    case 'gang': updateGang(p, dt); break;
    case 'down': {
      p.downT -= dt;
      if (p.downT <= 0 && p.koGone) { p.mode = 'gone'; break; }
      if (p.downT <= 0) { p.mode = 'flee'; p.fleeT = 4; p.speed = 80; bubble(p, pick(['¡Ay, mi espalda!', '¡Lo voy a demandar!', '¡Casi me mata!'])); }
      break;
    }
    case 'gone': p.alpha -= dt * 0.8; break;
    case 'thief': updateThief(p, dt); break;
    case 'cop': updateOfficer(p, dt); copShoot(p, dt); break;
    case 'dance': p.anim += dt * 8; p.angle += Math.sin(p.t * 3) * dt * 2; break;
    case 'static': p.anim = 0; break;
  }
}

function hitPed(p, v) {
  if (p.mode === 'down' || p.mode === 'gone' || p.keep) return;
  const sp = Math.hypot(v.vx, v.vy);
  p.mode = 'down'; p.downT = 2.5; p.angle = Math.atan2(v.vy, v.vx);
  const l = sp || 1; moveCircle(p, v.vx / l * 14, v.vy / l * 14, 5);
  Sound.sfx('bump');
  addFx('spark', p.x, p.y, rand(-40, 40), rand(-40, 40), 0.3);
  if (v.driver === 'player') {
    G.rep = Math.max(0, G.rep - 1);
    floater(p.x, p.y - 16, '-1 ⭐ reputación', '#ff8a80');
    if (p.mode === 'cop' || p.officer) addWanted(1, 'Atropellaste a un policía');
    else if (copWitness(p.x, p.y) || Math.random() < 0.4) addWanted(1, 'Atropellaste a un peatón');
  }
}

// ---------- Ladrón de celulares (evento) ----------
function updateThief(p, dt) {
  const pl = G.player;
  const dx = p.x - pl.x, dy = p.y - pl.y, l = Math.hypot(dx, dy) || 1;
  moveCircle(p, dx / l * 128 * dt + Math.sin(p.t * 3) * 30 * dt, dy / l * 128 * dt + Math.cos(p.t * 2.3) * 30 * dt, 5);
  p.angle = Math.atan2(dy, dx); p.anim += dt * 18;
  p.thiefT -= dt;
  if (l < 16) {
    G.phone = p.stolenPhone; p.mode = 'flee'; p.fleeT = 3; p.fx = pl.x; p.fy = pl.y;
    notify('📱 ¡Recuperaste el celular!', '+3 reputación. Ese ladrón no vuelve por acá.', '#69f0ae');
    G.rep += 3; Sound.sfx('success'); floater(pl.x, pl.y - 20, '¡Recuperado!', '#69f0ae');
  } else if (p.thiefT <= 0 || l > 700) {
    p.mode = 'gone';
    notify('📱 Se voló el ladrón', 'Te tocó comprar otro celular en San Andresito.', '#ff8a80');
  }
}

// ---------- Policía ----------
function copWitness(x, y) {
  for (const v of G.vehicles) if (v.type === 'police' && v.driver !== 'player' && v.driver !== null && dist(v.x, v.y, x, y) < 430 && losClear(v.x, v.y, x, y)) return true;
  for (const p of G.peds) if (p.mode === 'cop' && dist(p.x, p.y, x, y) < 380 && losClear(p.x, p.y, x, y)) return true;
  return false;
}

function makeCop(v) {
  if (v.mode === 'traffic') { const vv = vehVel(v); v.vx = vv[0]; v.vy = vv[1]; }
  v.mode = 'physics'; v.driver = 'cop'; v.chase = true; v.siren = true; v.wp = null; v.persist = false;
}

function updateCopCar(v, dt) {
  const p = G.player;
  const tx = p.onFoot ? p.x : p.vehicle.x, ty = p.onFoot ? p.y : p.vehicle.y;
  const pvx = p.onFoot ? 0 : p.vehicle.vx, pvy = p.onFoot ? 0 : p.vehicle.vy;
  const d = dist(v.x, v.y, tx, ty);
  let ax, ay;
  if (!v.chase) {
    // Sin persecución: se van por la calle hasta desaparecer
    if (!v.wp || dist(v.x, v.y, v.wp[0], v.wp[1]) < 70) {
      const n = nearestNode(v.x, v.y), ex = nodeExits(n[0], n[1]);
      const dd = pick(ex); const c = nodeCenter(n[0] + DIRV[dd][0], n[1] + DIRV[dd][1]);
      v.wp = c;
    }
    ax = v.wp[0]; ay = v.wp[1];
  } else if ((d < 280 && !p.hidden && losClear(v.x, v.y, tx, ty)) || !G.bfs) {
    ax = tx + pvx * 0.35; ay = ty + pvy * 0.35;
  } else {
    // Navegar por la red de calles usando el campo BFS hacia el jugador
    const W = BX + 1;
    if (!v.wpn) v.wpn = nearestNode(v.x, v.y);
    let c = nodeCenter(v.wpn[0], v.wpn[1]);
    if (dist(v.x, v.y, c[0], c[1]) < 70) {
      const cd = G.bfs[v.wpn[1] * W + v.wpn[0]];
      let best = null, bd = cd < 0 ? 999 : cd;
      for (const dd of nodeExits(v.wpn[0], v.wpn[1])) {
        const ni = v.wpn[0] + DIRV[dd][0], nj = v.wpn[1] + DIRV[dd][1], val = G.bfs[nj * W + ni];
        if (val >= 0 && val < bd) { bd = val; best = [ni, nj]; }
      }
      if (best) v.wpn = best; else { v.wpn = null; ax = tx; ay = ty; }
      if (v.wpn) c = nodeCenter(v.wpn[0], v.wpn[1]);
    }
    if (ax == null) { ax = c[0]; ay = c[1]; }
  }
  let diff = angDiff(v.angle, Math.atan2(ay - v.y, ax - v.x));
  // Esquivar paredes con antenas
  const probe = a => solidAt(v.x + Math.cos(a) * 42, v.y + Math.sin(a) * 42);
  if (probe(v.angle)) diff += probe(v.angle - 0.7) ? 1.1 : -1.1;
  let steer = clamp(diff * 2.4, -1, 1);
  let throttle = Math.abs(diff) > 1.5 && v.speed > 90 ? 0.25 : 1;
  let brake = false;
  if (v.chase && p.onFoot && d < 90) { throttle = 0; brake = true; }
  if (v.chase && !p.onFoot && d < 60 && Math.abs(p.vehicle.speed) < 30) { throttle = 0.2; }
  // Atascado: reversa un momento
  if (Math.abs(v.speed) < 15 && throttle > 0.5) v.stuckT += dt; else v.stuckT = Math.max(0, v.stuckT - dt);
  if (v.stuckT > 1.1) { v.reverseT = 0.9; v.stuckT = 0; v.wpn = null; }
  if (v.reverseT > 0) { v.reverseT -= dt; throttle = -1; steer = -steer; }
  updatePhysicsVehicle(v, dt, { throttle, steer, brake });
  copCarShoot(v, dt);
  // Bajar un policía cuando el jugador va a pie
  if (v.chase && p.onFoot && d < 120 && Math.abs(v.speed) < 50 && !v.officerOut && !v.wrecked) {
    v.officerOut = true;
    const o = new Ped({ x: v.x + Math.cos(v.angle + 1.57) * 14, y: v.y + Math.sin(v.angle + 1.57) * 14, mode: 'cop', look: { skin: pick(SKINS), hair: '#1b5e20', shirt: '#2e7d32', pants: '#1b2a1b' } });
    o.officer = true; o.umbrella = null; o.speed = 132;
    if (circleFree(o.x, o.y, 5)) G.peds.push(o);
    if (Math.random() < 0.6) bubble(o, pick(['¡Alto ahí!', '¡Quieto, mijo!', '¡Policía! ¡No se mueva!']));
  }
}

function updateOfficer(p, dt) {
  const pl = G.player;
  if (G.wanted <= 0) { p.mode = 'gone'; return; }
  const tx = pl.x, ty = pl.y;
  const dx = tx - p.x, dy = ty - p.y, l = Math.hypot(dx, dy) || 1;
  if (pl.hidden && l > 40) { p.anim = 0; return; }
  moveCircle(p, dx / l * p.speed * dt, dy / l * p.speed * dt, 5);
  p.angle = Math.atan2(dy, dx); p.anim += dt * 16;
  if (l > 1500) p.mode = 'gone';
}

/** Patrulla nueva fuera de pantalla, ya persiguiendo. */
function spawnCop() {
  const v = spawnTraffic('police', 650, 1150);
  if (v) makeCop(v);
}

// ==========================================================================
// ESTADO GLOBAL
// ==========================================================================
const G = {
  state: 'title', menu: null, overlay: null, bigmap: false,
  minutes: 7 * 60, day: 1, weather: 'sol', weatherT: 160, rain: 0, wetness: 0, trafficMul: 1, lightning: 0, forceStorm: false,
  player: null, vehicles: [], peds: [], pickups: [], fx: [], floaters: [], bubbles: [], skids: [],
  focus: { x: 0, y: 0 }, spawnT: 0, pedT: 0,
  money: 50000, rep: 0, wanted: 0, unseen: 0, peakWanted: 0, bustT: 0, bfs: null, bfsT: 0, copSpawnT: 0,
  phone: 0, clothes: {}, homes: { kennedy: true }, home: 'kennedy', biz: {}, inv: {}, invCost: {}, garage: [], outVeh: null,
  mission: null, offers: null, offersT: 0, eventT: 45,
  events: { checkpoint: null, closed: null, jam: null, bonus: 0, strike: 0, festival: null },
  stats: { deliveries: 0, missions: 0, earned: 0, potholes: 0, hustle: 0, busted: 0, wasted: 0, played: 0 },
  ach: {}, visited: {}, name: 'Parce', shirt: '#e53935',
  waypoint: null, lockHint: null, lockToastT: 0, saveT: 30, gps: null, gpsT: 0, districtNow: null,
  clubNight: -1, festivalDone: false,
  city: 'bogota', cityVisited: { bogota: true }, bullets: [], grenades: [], scorch: [],
  weapons: { punos: true }, ammo: {}, weapon: 'punos', fireCD: 0, snitchCD: 0, flash: 0,
  coolT: 0, chatT: 6, carry: null, maicena: 0, minigame: null, bm: null, mouse: null,
};
function newPlayer(x, y) {
  return { x, y, vx: 0, vy: 0, angle: -Math.PI / 2, onFoot: true, vehicle: null, health: 100, energy: 100, hidden: false, hideT: 0, anim: 0, moving: false, hurtT: 0 };
}
function poi(id) { return World.pois.find(p => p.id === id); }
function playerLook() {
  const c = G.clothes, hot = CITY.climate === 'calor';
  return {
    skin: '#e0ac69', hair: '#2b1b0e',
    shirt: c.pinta ? '#1a237e' : hot && c.guayabera ? '#fafafa' : CITY.id === 'cali' && c.salsero ? '#e91e63' : c.cuero && !hot ? '#212121' : c.impermeable && G.rain > 0.2 ? '#fdd835' : G.shirt,
    pants: c.pinta ? '#1a237e' : hot ? '#5d4037' : '#263238', ruana: !!c.ruana && !hot, gafas: !!c.gafas,
    sombrero: !!c.sombrero && (hot || CITY.id === 'medellin'), marimonda: !!c.marimonda && CITY.id === 'barranquilla',
    silleta: G.carry === 'silleta', carriel: !!c.carriel && CITY.id === 'medellin',
  };
}

// ==========================================================================
// 8. SISTEMAS: jugador, hora, clima, policía
// ==========================================================================
function damagePlayer(n) {
  const p = G.player;
  if (G.overlay) return;
  p.health = Math.max(0, p.health - n); p.hurtT = 0.4;
  if (p.health <= 0) wasted();
}

function updatePlayer(dt) {
  const p = G.player;
  if (p.hurtT > 0) p.hurtT -= dt;
  if (p.hidden) {
    p.hideT += dt;
    const mv = Math.abs(Input.ax()) + Math.abs(Input.ay());
    if ((Input.hit('e') || mv > 0.5) && p.hideT > 0.6) { p.hidden = false; toast('Saliste del escondite'); }
    return;
  }
  if (p.onFoot) {
    const ax = Input.ax(), ay = Input.ay(), l = Math.hypot(ax, ay);
    const tired = p.energy < 12;
    const running = (Input.down('shift', 'space') || (Input.joy.on && l > 0.92)) && !tired;
    const sp = (running ? 155 : 92) * (G.clothes.tenis ? 1.12 : 1) * (tired ? 0.8 : 1);
    if (l > 0.1) {
      const k = Input.joy.on ? Math.min(1, l) / l : 1 / l;
      const ox = p.x, oy = p.y;
      moveCircle(p, ax * k * sp * dt, ay * k * sp * dt, 6, true);
      p.vx = (p.x - ox) / dt; p.vy = (p.y - oy) / dt;
      p.angle += angDiff(p.angle, Math.atan2(ay, ax)) * Math.min(1, dt * 14);
      p.anim += dt * sp * 0.14; p.moving = true;
      if (running) p.energy -= 0.5 * dt;
    } else { p.moving = false; p.vx = p.vy = 0; }
    pushPlayerOutOfVehicles(p);
  } else {
    const v = p.vehicle;
    let ctl;
    if (Input.joy.on) {
      const jx = Input.joy.x, jy = Input.joy.y, m = Math.min(1, Math.hypot(jx, jy));
      const diff = angDiff(v.angle, Math.atan2(jy, jx));
      if (Math.abs(diff) > 2.3 && v.speed < 60) ctl = { throttle: -m, steer: -Math.sign(diff), brake: false };
      else ctl = { throttle: m * (Math.abs(diff) > 1.6 ? 0.4 : 1), steer: clamp(diff * 2.6, -1, 1), brake: Input.down('space') };
    } else ctl = { throttle: (Input.down('up') ? 1 : 0) - (Input.down('down') ? 1 : 0), steer: Input.ax(), brake: Input.down('space') };
    updatePhysicsVehicle(v, dt, ctl);
    p.x = v.x; p.y = v.y; p.angle = v.angle; p.vx = v.vx; p.vy = v.vy;
    if (!v.spec.engine) { p.energy -= 0.22 * dt * Math.abs(ctl.throttle); p.anim += dt * Math.abs(v.speed) * 0.08; }
    // Atropellos
    if (Math.abs(v.speed) > 45) for (const pd of G.peds) {
      if (pd.mode === 'down' || pd.mode === 'gone' || pd.keep) continue;
      if (Math.abs(pd.x - v.x) > 40 || Math.abs(pd.y - v.y) > 40) continue;
      for (const c of vehCircles(v)) if (dist(c[0], c[1], pd.x, pd.y) < c[2] + 5) { hitPed(pd, v); break; }
    }
    // Los peatones se apartan de un carro que viene rápido
    if (Math.abs(v.speed) > 140) for (const pd of G.peds) if (pd.mode === 'walk' && dist(pd.x, pd.y, v.x + v.vx * 0.4, v.y + v.vy * 0.4) < 50) scarePed(pd, v.x, v.y, 2);
  }
  if (Input.hit('h')) honk();
}

function pushPlayerOutOfVehicles(p) {
  for (const v of G.vehicles) {
    if (Math.abs(v.x - p.x) > 60 || Math.abs(v.y - p.y) > 60) continue;
    for (const c of vehCircles(v)) {
      const dx = p.x - c[0], dy = p.y - c[1], d = Math.hypot(dx, dy) || 0.01, min = c[2] + 6;
      if (d < min) {
        const nx = p.x + dx / d * (min - d), ny = p.y + dy / d * (min - d);
        if (circleFree(nx, ny, 6)) { p.x = nx; p.y = ny; }
        const sp = Math.hypot(v.vx, v.vy);
        if (v.mode === 'physics' && sp > 90 && v.driver !== 'player' && p.hurtT <= 0) {
          damagePlayer(sp * 0.08); shake(6); Sound.sfx('bump');
          if (v.driver === 'cop') floater(p.x, p.y - 20, '¡Auch!', '#ff8a80');
        }
      }
    }
  }
}

function honk() {
  const p = G.player;
  Sound.sfx('horn');
  for (const pd of G.peds) if (pd.mode === 'walk' && dist(pd.x, pd.y, p.x, p.y) < 110) scarePed(pd, p.x, p.y, 1.5);
}

function updateVitals(dt) {
  const p = G.player;
  const hour = G.minutes / 60;
  let drain = 0.07;
  if (p.onFoot && G.rain > 0.3 && !G.clothes.impermeable) drain += G.clothes.ruana ? 0.05 : 0.14;
  if (hour >= 23 || hour < 5) drain += 0.05;
  G.coolT = Math.max(0, G.coolT - dt);
  if (CITY.climate === 'calor' && hour >= 9 && hour < 17 && p.onFoot && !G.clothes.sombrero && G.coolT <= 0) {
    drain += 0.09;
    if (Math.random() < dt * 0.02) toast(pick(['🥵 ¡Qué calor tan berraco! Tómate algo frío', '🥵 ¡Eche, qué sol! Un raspao o un sombrero vueltiao te salvan']));
  }
  p.energy = clamp(p.energy - drain * dt, 0, 100);
  if (p.energy <= 0) { damagePlayer(0.6 * dt); if (Math.random() < dt * 0.15) toast('😵 Sin energía: come algo o vas a desmayarte'); }
  else if (p.energy > 50 && p.health < 100) p.health = Math.min(100, p.health + 0.06 * dt);
}

function enterVehicle(v) {
  const p = G.player;
  if (v.driver === 'npc' || v.driver === 'cop' || v.driver === 'post') {
    const fl = new Ped({ x: v.x + Math.cos(v.angle - 1.57) * 18, y: v.y + Math.sin(v.angle - 1.57) * 18, mode: 'flee', look: v.rider });
    fl.fleeT = 4; fl.fx = p.x; fl.fy = p.y; fl.speed = 110; fl.umbrella = null;
    if (circleFree(fl.x, fl.y, 5)) { G.peds.push(fl); bubble(fl, pick(['¡Ladrón! ¡Me robaron!', '¡Auxilio! ¡Mi carro!', '¡Policía, policía!'])); }
    v.stolen = true;
    if (v.type === 'police') addWanted(2, 'Te robaste una patrulla');
    else if (copWitness(p.x, p.y) || Math.random() < 0.65) addWanted(1, 'Robo de vehículo');
    if (v.mode === 'traffic') { const vv = vehVel(v); v.vx = vv[0]; v.vy = vv[1]; }
  } else if (!v.owned && !v.stolen) {
    v.stolen = true;
    if (copWitness(p.x, p.y) || Math.random() < 0.25) addWanted(1, 'Robo de vehículo');
  }
  v.mode = 'physics'; v.driver = 'player'; v.chase = false; v.siren = false; v.officerOut = false;
  p.onFoot = false; p.vehicle = v; p.hidden = false;
  Sound.sfx('door');
  if (v.owned) toast(`🔑 ${v.spec.name} (tuyo)`);
  else if (G.stats.played < 200) toast(isTouch() ? 'Inclina el joystick hacia donde quieres ir · 🏃 = freno de mano' : 'Manejas con W/S, giras con A/D, freno de mano con Espacio');
}

function exitVehicle() {
  const p = G.player, v = p.vehicle;
  const c = Math.cos(v.angle), s = Math.sin(v.angle), hw = v.spec.w / 2 + 9, hl = v.spec.len / 2 + 9;
  for (const [lx, ly] of [[0, -hw], [0, hw], [-hl, 0], [hl, 0]]) {
    const x = v.x + lx * c - ly * s, y = v.y + lx * s + ly * c;
    if (circleFree(x, y, 6) && canEnter(x, y)) {
      if (Math.abs(v.speed) > 90) { damagePlayer(Math.abs(v.speed) * 0.06); toast('🤕 ¡Te tiraste andando!'); }
      v.driver = null; p.vehicle = null; p.onFoot = true; p.x = x; p.y = y;
      Sound.sfx('door');
      return;
    }
  }
  toast('No hay espacio para bajarse aquí');
}

function tryToggleVehicle() {
  const p = G.player;
  if (!p.onFoot) { exitVehicle(); return true; }
  let best = null, bd = 1e9;
  for (const v of G.vehicles) {
    const d = dist(p.x, p.y, v.x, v.y) - v.spec.len / 2;
    if (d < 24 && d < bd) { bd = d; best = v; }
  }
  if (!best) return false;
  if (best.spec.nodrive) { toast(`Ni por el chiras le dejan manejar un ${CITY.troncal.name} 😅`); return true; }
  if (best.wrecked) { toast('Ese vehículo está varado 💥'); return true; }
  enterVehicle(best);
  return true;
}

// ---------- Búsqueda policial ----------
function addWanted(n, reason) {
  if (G.state !== 'play' || G.overlay) return;
  const before = G.wanted;
  G.wanted = Math.min(3, G.wanted + n); G.unseen = 0;
  G.peakWanted = Math.max(G.peakWanted, G.wanted);
  if (G.wanted > before) { notify('🚨 ' + reason, '★'.repeat(G.wanted) + '☆'.repeat(3 - G.wanted) + '  La policía te está buscando', '#ff5252'); Sound.sfx('star'); }
  const p = G.player;
  for (const v of G.vehicles) if (v.type === 'police' && v.driver !== 'player' && v.driver !== null && dist(v.x, v.y, p.x, p.y) < 800) makeCop(v);
  if (G.events.checkpoint && G.events.checkpoint.car && dist(G.events.checkpoint.x, G.events.checkpoint.y, p.x, p.y) < 600) makeCop(G.events.checkpoint.car);
}

function updateWanted(dt) {
  const p = G.player;
  if (G.wanted <= 0) {
    for (const v of G.vehicles) if (v.driver === 'cop' && v.chase) { v.chase = false; v.siren = false; v.wp = null; }
    G.bustT = 0;
    return;
  }
  G.bfsT -= dt;
  if (G.bfsT <= 0) { const n = nearestNode(p.x, p.y); G.bfs = bfsFrom(n[0], n[1]); G.bfsT = 0.5; }
  let seen = false;
  if (!p.hidden) {
    for (const v of G.vehicles) if (v.driver === 'cop' && v.chase && !v.wrecked && dist(v.x, v.y, p.x, p.y) < 470 && losClear(v.x, v.y, p.x, p.y)) { seen = true; break; }
    if (!seen) for (const o of G.peds) if (o.mode === 'cop' && dist(o.x, o.y, p.x, p.y) < 400 && losClear(o.x, o.y, p.x, p.y)) { seen = true; break; }
  }
  G.unseen = seen ? 0 : G.unseen + dt;
  const need = p.hidden ? 3 + G.wanted * 2 : 7 + G.wanted * 4;
  G.escape = G.unseen / need;
  if (G.unseen >= need) {
    G.wanted--; G.unseen = 0;
    if (G.wanted === 0) {
      notify('😎 ¡Te volaste!', 'La policía perdió tu rastro.', '#69f0ae');
      Sound.sfx('success');
      if (G.peakWanted >= 3) unlock('fugitive');
      G.peakWanted = 0;
      for (const o of G.peds) if (o.mode === 'cop') o.mode = 'gone';
      return;
    }
    toast('Bajó la búsqueda: ' + '★'.repeat(G.wanted));
  }
  // Mantener suficientes patrullas
  const want = [0, 2, 3, 5][G.wanted];
  const cops = G.vehicles.filter(v => v.driver === 'cop' && v.chase && !v.wrecked).length;
  G.copSpawnT -= dt;
  if (cops < want && G.copSpawnT <= 0) { spawnCop(); G.copSpawnT = 3 - G.wanted * 0.5; }
  // ¿Te cogieron?
  let caught = false;
  if (p.onFoot && !p.hidden) {
    for (const o of G.peds) if (o.mode === 'cop' && dist(o.x, o.y, p.x, p.y) < 14) caught = true;
    for (const v of G.vehicles) if (v.driver === 'cop' && v.chase && dist(v.x, v.y, p.x, p.y) < 30 && Math.abs(v.speed) < 40) caught = true;
  } else if (!p.onFoot) {
    const pv = p.vehicle;
    if (Math.abs(pv.speed) < 28 || pv.wrecked) {
      for (const v of G.vehicles) if (v.driver === 'cop' && v.chase && dist(v.x, v.y, pv.x, pv.y) < 48 + pv.spec.len / 2) caught = true;
      for (const o of G.peds) if (o.mode === 'cop' && dist(o.x, o.y, pv.x, pv.y) < pv.spec.len / 2 + 10) caught = true;
    }
  }
  if (caught) { G.bustT += dt; if (G.bustT > 1.3) busted(); } else G.bustT = Math.max(0, G.bustT - dt);
}

function respawnAt(x, y) {
  const p = G.player;
  if (p.vehicle) { p.vehicle.driver = null; if (!p.vehicle.owned) p.vehicle.persist = false; }
  p.vehicle = null; p.onFoot = true; p.hidden = false; p.x = x; p.y = y;
  G.wanted = 0; G.unseen = 0; G.bustT = 0; G.peakWanted = 0;
  G.vehicles = G.vehicles.filter(v => v.driver !== 'cop' && (v.owned || v.persist || v.mission) );
  G.peds = [];
  if (G.mission) failMission(G.overlay && G.overlay.type === 'busted' ? 'Te cogió la policía' : 'Terminaste en el hospital');
  cam.x = x; cam.y = y;
}

function wasted() {
  if (G.overlay) return;
  const bill = Math.min(G.money, Math.max(20000, Math.round(G.money * 0.1)));
  G.stats.wasted++;
  G.overlay = { type: 'wasted', t: 3.2, title: '¡QUEDASTE FRITO!', sub: `La cuenta del hospital: ${fmtMoney(bill)}`, bill };
  Sound.sfx('fail');
}
function busted() {
  if (G.overlay) return;
  const fine = Math.min(G.money, Math.max(30000, Math.round(G.money * 0.15)));
  G.stats.busted++;
  G.overlay = { type: 'busted', t: 3.2, title: '¡TE COGIÓ LA TOMBA!', sub: `Multa y noche en la estación: ${fmtMoney(fine)}`, bill: fine };
  Sound.sfx('fail');
}
function updateOverlay(dt) {
  const o = G.overlay;
  o.t -= dt;
  if (o.t > 0) return;
  G.money -= o.bill;
  if (o.type === 'wasted') {
    const hs = World.pois.filter(p => p.type === 'hospital' && districtUnlocked(districtAt(p.x, p.y)));
    const h = hs.sort((a, b) => dist(a.x, a.y, G.player.x, G.player.y) - dist(b.x, b.y, G.player.x, G.player.y))[0] || poi('hosp1');
    respawnAt(h.x, h.y);
    G.player.health = 70; G.player.energy = Math.max(G.player.energy, 40);
    notify('🏥 Saliste del hospital', 'Pilas pues con esa manera de vivir.', '#ef9a9a');
  } else {
    const ps = poi('police1');
    respawnAt(ps.x, ps.y);
    advanceTime(180);
    G.player.health = Math.max(G.player.health, 50);
    notify('🚓 Saliste de la estación', 'Te quitaron el vehículo y pagaste la multa.', '#90caf9');
  }
  G.overlay = null;
  saveGame(true);
}

// ---------- Hora y clima ----------
function updateTime(dt) {
  G.minutes += dt * MIN_PER_SEC;
  if (G.minutes >= 1440) { G.minutes -= 1440; newDay(); }
}
function advanceTime(mins) {
  G.minutes += mins;
  while (G.minutes >= 1440) { G.minutes -= 1440; newDay(); }
}
function clockStr(m = G.minutes) {
  const h = Math.floor(m / 60) % 24, mm = Math.floor(m % 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm < 10 ? '0' : ''}${mm} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}
function newDay() {
  G.day++;
  const parts = [];
  let net = 0;
  const ownsHome = Object.keys(G.homes).some(k => k !== 'kennedy' && G.homes[k]);
  if (!ownsHome) { net -= HOMES.kennedy.rent; parts.push(`Arriendo -${fmtMoney(HOMES.kennedy.rent)}`); }
  let inc = 0;
  for (const k in G.biz) if (G.biz[k]) inc += Math.round(BIZ[k].income * rand(0.85, 1.15) / 1000) * 1000;
  if (inc) { net += inc; parts.push(`Negocios +${fmtMoney(inc)}`); }
  G.money += net;
  if (inc) G.stats.earned += inc;
  if (G.money < 0) { G.money = 0; G.rep = Math.max(0, G.rep - 2); parts.push('Quedaste debiendo: -2 ⭐'); }
  notify(`📅 Día ${G.day}`, parts.join(' · ') || 'Un nuevo día en la ciudad.', '#ffd54f');
  G.offers = null;
  if (G.money >= 10000000) unlock('rich');
}
function darkness() {
  const h = G.minutes / 60;
  let d;
  if (h >= 7 && h < 17) d = 0;
  else if (h >= 17 && h < 19.5) d = (h - 17) / 2.5;
  else if (h >= 19.5 || h < 5) d = 1;
  else d = 1 - (h - 5) / 2;
  return d * 0.64 + (G.weather === 'nublado' ? 0.05 : 0) + G.rain * 0.07;
}
function setWeather(w, dur) { G.weather = w; G.weatherT = dur; }
function updateWeather(dt) {
  G.weatherT -= dt;
  if (G.weatherT <= 0 && !G.forceStorm) {
    if (G.weather === 'lluvia' || G.weather === 'tormenta') setWeather('nublado', rand(70, 140));
    else { const r = Math.random(); setWeather(r < 1 - CITY.rain - 0.1 ? 'sol' : r < 1 - CITY.rain * 0.43 ? 'nublado' : 'lluvia', rand(90, 200)); }
  }
  const target = { sol: 0, nublado: 0, lluvia: 0.65, tormenta: 1 }[G.weather];
  G.rain = approach(G.rain, target, dt * 0.15);
  G.wetness = G.rain > 0.1 ? approach(G.wetness, 1, dt * 0.1) : approach(G.wetness, 0, dt * 0.015);
  G.trafficMul = 1 - G.rain * 0.28;
  if (G.weather === 'tormenta' && Math.random() < dt * 0.1) { G.lightning = 1; setTimeout(() => Sound.sfx('thunder'), rand(150, 900)); }
  G.lightning = Math.max(0, G.lightning - dt * 2.5);
}

// ---------- Población de la ciudad (tráfico, peatones, carros parqueados) ----------
function manageWorld(dt) {
  const f = G.focus;
  G.spawnT -= dt;
  if (G.spawnT > 0) return;
  G.spawnT = 0.2;
  const p = G.player;
  G.vehicles = G.vehicles.filter(v => {
    if (v === p.vehicle || v.persist || v.mission || v.owned) return true;
    const d = dist(v.x, v.y, f.x, f.y);
    if (v.driver === 'cop' && v.chase) return d < 2200;
    if (v.wrecked) return d < 1400;
    return d < 1500;
  });
  G.peds = G.peds.filter(pd => pd.alpha > 0 && (pd.keep || dist(pd.x, pd.y, f.x, f.y) < 1250));
  // Tráfico
  const night = G.minutes < 5 * 60 || G.minutes > 22 * 60;
  const target = Math.round(26 * (night ? 0.6 : 1) * (1 + G.rain * 0.35));
  let traffic = 0, tm = 0, parked = 0;
  for (const v of G.vehicles) {
    if (v.mode === 'traffic') { if (v.type === 'tm') tm++; else traffic++; }
    else if (v.driver === null && !v.owned) parked++;
  }
  if (traffic < target) spawnTraffic();
  if (tm < 3) {
    const nearTroncal = Math.abs(f.y - (6 * PT + 48)) < 1300 || Math.abs(f.x - (4 * PT + 48)) < 1300;
    if (nearTroncal) spawnTraffic('tm', 600, 1500);
  }
  // Carros y motos parqueados para "tomar prestados"
  if (parked < 6) {
    for (let k = 0; k < 4; k++) {
      const s = pick(World.parking), d = dist(s.x, s.y, f.x, f.y);
      if (d < 380 || d > 1100 || onScreen(s.x, s.y, 60)) continue;
      if (G.vehicles.some(v => dist(v.x, v.y, s.x, s.y) < 30)) continue;
      const type = pick(['sedan', 'sedan', 'moto', 'moto', 'bici', 'suv', 'taxi']);
      const v = new Vehicle(type, s.x, s.y, s.a + (Math.random() < 0.5 ? Math.PI : 0), { mode: 'physics', driver: null });
      if (!vehicleBlocked(v, v.x, v.y, v.angle)) { G.vehicles.push(v); break; }
    }
  }
  // Peatones
  const busy = { D: 7, L: 6, Z: 6, C: 5, K: 5, S: 4, U: 4, A: 0 };
  const pedTarget = night ? 22 : 44;
  let walkers = 0;
  for (const pd of G.peds) if (pd.mode === 'walk') walkers++;
  if (walkers < pedTarget) {
    const [fbi, fbj] = blockOf(f.x, f.y);
    for (let k = 0; k < 3; k++) {
      const bi = clamp(fbi + randi(-2, 2), 0, BX - 1), bj = clamp(fbj + randi(-2, 2), 0, BY - 1);
      const d = DISTRICT_GRID[bj][bi];
      if (d === 'A' || Math.random() * 7 > (busy[d] != null && CITY.id === 'bogota' ? busy[d] : 5) * (night && dStyle(d).kind === 'glass' ? 1.6 : 1)) continue;
      const pd = new Ped({ bi, bj, d: Math.random() * 4 * 12 * T });
      const dd = dist(pd.x, pd.y, f.x, f.y);
      if (dd < 300 || dd > 1150 || onScreen(pd.x, pd.y, 30)) continue;
      G.peds.push(pd);
    }
  }
}

function updateVehicles(dt) {
  const p = G.player;
  for (const v of G.vehicles) {
    if (v === p.vehicle) continue;
    if (v.mode === 'traffic') {
      if (v.race) updateRaceBus(v, dt); else updateTrafficCar(v, dt);
    } else if (v.driver === 'cop') updateCopCar(v, dt);
    else if (v.driver !== 'racer') updatePhysicsVehicle(v, dt, NOCTL);
  }
  for (const v of G.vehicles) updateBurning(v, dt);
  collideVehicles();
  // Patrullas que atropellan peatones
  for (const v of G.vehicles) {
    if (v.driver !== 'cop' || Math.abs(v.speed) < 60) continue;
    for (const pd of G.peds) if (pd.mode === 'walk' && dist(pd.x, pd.y, v.x, v.y) < 45) scarePed(pd, v.x, v.y, 2);
  }
}

/** El articulado de la carrera ignora a los demás y sigue su ruta. */
function updateRaceBus(v, dt) {
  if (v.stopT > 0) { v.stopT -= dt; v.speed = approach(v.speed, 0, 400 * dt); }
  else v.speed = approach(v.speed, v.cruise, 120 * dt);
  for (const st of World.stations) {
    if (v.lastStation === st) continue;
    const onAxis = st.axis === 'h' ? v.dir % 2 === 0 : v.dir % 2 === 1;
    if (onAxis && (st.axis === 'h' ? Math.abs(v.x - st.x) < 6 && Math.abs(v.y - st.y) < 90 : Math.abs(v.y - st.y) < 6 && Math.abs(v.x - st.x) < 90)) { v.stopT = 2.5; v.lastStation = st; }
  }
  const f = DIRV[v.dir];
  v.x += f[0] * v.speed * dt; v.y += f[1] * v.speed * dt;
  v.angle += angDiff(v.angle, DIR_ANG[v.dir]) * Math.min(1, dt * 9);
  handleTurn(v);
}

// ==========================================================================
// 9. MISIONES
// ==========================================================================
function mkMission(type, o) {
  const info = MISSION_INFO[type];
  return Object.assign({ type, title: info.title, icon: info.icon, color: info.color, steps: [], idx: 0, timer: null, timerMax: null, data: {}, hint: null }, o);
}
function currentTarget() {
  const m = G.mission;
  if (m) { const st = m.steps[m.idx]; if (st && st.x != null) return { x: st.x, y: st.y, color: m.color }; }
  if (G.waypoint) return { x: G.waypoint.x, y: G.waypoint.y, color: '#ffd54f' };
  return null;
}
function startMission(m) {
  if (G.mission) { toast('Ya tienes una misión activa'); return; }
  G.mission = m; m.idx = 0;
  if (m.onStart) m.onStart();
  const st = m.steps[0];
  if (st && st.onEnter) st.onEnter();
  banner(`${m.icon} ${m.title}`, st ? st.text : '', m.color);
  Sound.sfx('notify');
  G.gpsT = 0;
}
function completeMission(pay, rep, extra) {
  const m = G.mission; if (!m) return;
  if (m.cleanup) m.cleanup();
  G.mission = null;
  if (pay) addMoney(pay);
  G.rep += rep; G.stats.missions++;
  banner('¡MISIÓN CUMPLIDA!', `${pay ? '+' + fmtMoney(pay) : ''}${rep ? '   +' + rep + ' ⭐' : ''}${extra ? '   ' + extra : ''}`, '#69f0ae', true);
  Sound.sfx('success');
  checkUnlocks();
  saveGame(true);
}
function failMission(reason) {
  const m = G.mission; if (!m) return;
  if (m.cleanup) m.cleanup();
  G.mission = null;
  banner('MISIÓN FALLIDA', reason, '#ff5252', true);
  Sound.sfx('fail');
}
function updateMission(dt) {
  const m = G.mission; if (!m) return;
  if (m.update) { m.update(dt); if (G.mission !== m) return; }
  if (m.timer != null) {
    m.timer -= dt;
    if (m.timer <= 0) { failMission(m.timeoutText || '¡Se acabó el tiempo!'); return; }
  }
  const st = m.steps[m.idx]; if (!st) return;
  const p = G.player;
  m.hint = null;
  if (st.cond) { if (!st.cond()) return; }
  else {
    if (dist(p.x, p.y, st.x, st.y) > st.r) return;
    if (st.needSeats && (p.onFoot || p.vehicle.spec.seats < 2)) { m.hint = 'Necesitas carro o moto (con puesto para el pasajero)'; return; }
    if (st.stop && !p.onFoot && Math.abs(p.vehicle.speed) > 45) { m.hint = 'Frena para ' + (st.stopText || 'parar aquí'); return; }
    if (st.check && !st.check()) { m.hint = st.checkHint || null; return; }
  }
  if (st.onReach) st.onReach();
  if (G.mission !== m) return;
  m.idx++;
  if (m.idx >= m.steps.length) { m.onDone(); return; }
  const ns = m.steps[m.idx];
  if (ns.onEnter) ns.onEnter();
  toast('➡️ ' + ns.text);
  Sound.sfx('coin');
  G.gpsT = 0;
}

/** Nivel de vehículo para calcular distancias y tiempos de domicilio. */
function deliveryTier() {
  const p = G.player;
  const types = G.garage.map(g => g.type);
  if (!p.onFoot) types.push(p.vehicle.type);
  if (types.some(t => t !== 'bici')) return 2;
  if (types.includes('bici')) return 1;
  return 0;
}
function genDeliveryOffers(n = 3) {
  const tier = deliveryTier(), p = G.player;
  const range = [[500, 1500], [900, 2500], [1400, 3800]][tier];
  const speedRef = [98, 160, 210][tier];
  const out = [];
  for (let k = 0; k < n * 3 && out.length < n; k++) {
    const a = randomSidewalkPoint((d, x, y) => districtUnlocked(d) && dist(x, y, p.x, p.y) < 900 && dist(x, y, p.x, p.y) > 120);
    if (!a) continue;
    const L = rand(range[0], range[1]);
    const b = randomSidewalkPoint((d, x, y) => districtUnlocked(d) && Math.abs(dist(x, y, a.x, a.y) - L) < 450);
    if (!b) continue;
    const man = Math.abs(b.x - a.x) + Math.abs(b.y - a.y), toA = Math.abs(a.x - p.x) + Math.abs(a.y - p.y);
    out.push({
      rest: pick(RESTAURANT_NAMES), client: pick(CLIENT_NAMES), a, b, addr: addressOf(b.x, b.y),
      pay: round500((7000 + man * 8.5) * (G.phone === 2 ? 1.25 : 1)),
      time: Math.round((man + toA) / speedRef + 22),
    });
  }
  return out;
}
function missionDelivery(o) {
  const m = mkMission('delivery', { timer: o.time, timerMax: o.time, data: { cond: 100, picked: false } });
  m.steps = [
    { x: o.a.x, y: o.a.y, r: 34, stop: true, stopText: 'recoger el pedido', text: `Recoge el pedido en ${o.rest}`, onReach() { m.data.picked = true; floater(o.a.x, o.a.y - 20, '🍔 ¡Pedido listo!', '#ffd54f'); } },
    { x: o.b.x, y: o.b.y, r: 34, stop: true, stopText: 'entregar', text: `Entrégale a ${o.client}: ${o.addr}` },
  ];
  m.onImpact = (imp, pot) => {
    if (!m.data.picked) return;
    const loss = pot ? 4 : (imp - 40) * 0.12;
    m.data.cond = Math.max(0, m.data.cond - loss);
    if (loss > 3) floater(G.player.x, G.player.y - 30, `Pedido ${Math.round(m.data.cond)}%`, '#ffab40');
  };
  m.extra = () => m.data.picked ? `🍔 Estado del pedido: ${Math.round(m.data.cond)}%` : `💵 Paga ${fmtMoney(o.pay)}`;
  m.onDone = () => {
    const mult = (G.events.bonus > 0 ? 2 : 1) * (G.rain > 0.4 ? 1.3 : 1) * (G.events.strike > 0 ? 1.5 : 1);
    const q = 0.4 + 0.6 * m.data.cond / 100;
    const tip = m.timer > m.timerMax * 0.35 && m.data.cond > 70 ? round500(o.pay * 0.25) : 0;
    G.stats.deliveries++; unlock('first_delivery');
    completeMission(round500(o.pay * mult * q) + tip, m.data.cond > 90 ? 2 : 1, tip ? `(propina ${fmtMoney(tip)})` : '');
  };
  return m;
}

function missionTMRace() {
  const start = World.stations.find(s => s.station === 'Portal Américas');
  const end = World.stations.find(s => s.station === 'Portal Norte');
  const m = mkMission('tmrace', { data: { count: 3 } });
  const total = (4 * PT + 48 - start.x) + (6 * PT + 48 - end.y);
  m.onStart = () => {
    const bus = spawnTrafficOn({ h: true, i: 0, j: 6 }, 0, start.x - 40, 'tm');
    bus.persist = true; bus.race = true; bus.cruise = 250;
    bus.route = (i, j, exits) => (j === 6 && i < 4 && exits.includes(0) ? 0 : exits.includes(3) ? 3 : null);
    bus.stopT = 3; bus.lastStation = start;
    m.data.bus = bus;
    floater(G.player.x, G.player.y - 30, '3… 2… 1… ¡YA!', '#ff5252');
  };
  m.steps = [{ x: end.x, y: end.y, r: 52, text: 'Llega al Portal Norte antes que el TransMilenio' }];
  m.update = () => {
    const b = m.data.bus;
    const done = b.dir === 0 ? b.x - start.x : (4 * PT + 48 - start.x) + (6 * PT + 48 - b.y);
    m.data.prog = clamp(done / total, 0, 1);
    if (b.dir === 3 && b.y <= end.y + 6) failMission('El TransMilenio llegó primero 🚌💨');
  };
  m.extra = () => `🚌 Avance del TM: ${Math.round((m.data.prog || 0) * 100)}%`;
  m.cleanup = () => { const b = m.data.bus; if (b) { b.persist = false; b.race = false; b.route = null; b.cruise = 160; } };
  m.onDone = () => { unlock('tm'); completeMission(120000, 5, '¡Le ganaste al articulado!'); };
  return m;
}

function missionAirport(giver) {
  const ap = World.airport;
  const m = mkMission('airport', { data: { comfort: 100, boarded: false, outT: 0, chatT: 6 } });
  const tourist = new Ped({ x: giver.x + 14, y: giver.y, mode: 'static', look: { skin: '#ffdbac', hair: '#f5d76e', shirt: '#26c6da', pants: '#f5f5f5' } });
  tourist.keep = true; tourist.umbrella = null; tourist.icon = '🧳';
  m.onStart = () => G.peds.push(tourist);
  m.steps = [
    { x: giver.x, y: giver.y, r: 64, needSeats: true, stop: true, stopText: 'recoger al turista', text: 'Recoge al turista en el hotel (necesitas carro o moto)',
      onReach() {
        tourist.alpha = 0; tourist.mode = 'gone'; tourist.keep = false;
        const man = Math.abs(ap.x - giver.x) + Math.abs(ap.y - giver.y);
        m.timer = m.timerMax = Math.round(man / 215 + 22);
        m.data.boarded = true; m.data.veh = G.player.vehicle;
        bubble(G.player, 'Hello! El Dorado, please. ¡Rápido, rápido!');
      } },
    { x: ap.x, y: ap.y, r: 72, stop: true, stopText: 'dejar al turista', text: 'Lleva al turista a la Terminal El Dorado ✈️' },
  ];
  m.update = dt => {
    if (!m.data.boarded) return;
    const p = G.player;
    if (p.onFoot || p.vehicle !== m.data.veh) { m.data.outT += dt; m.hint = 'El turista te espera en el vehículo'; if (m.data.outT > 7) failMission('El turista se cansó y pidió un taxi'); }
    else m.data.outT = 0;
    if (m.data.veh.wrecked) failMission('Volviste nada el carro con el turista adentro');
    m.data.chatT -= dt;
    if (m.data.chatT <= 0) { m.data.chatT = rand(7, 11); bubble(G.player, pick(TOURIST_LINES)); }
  };
  m.onImpact = (imp, pot) => {
    if (!m.data.boarded) return;
    m.data.comfort = Math.max(0, m.data.comfort - (pot ? 6 : (imp - 40) * 0.1));
    if (pot) bubble(G.player, 'Oh my god, the potholes!');
    else if (imp > 90) bubble(G.player, '¡Cuidado, señor!');
  };
  m.extra = () => m.data.boarded ? `😬 Comodidad del turista: ${Math.round(m.data.comfort)}%` : '💵 Paga hasta $250.000';
  m.cleanup = () => { tourist.keep = false; tourist.mode = 'gone'; };
  m.onDone = () => {
    const tip = m.timer > m.timerMax * 0.3 ? 50000 : 0;
    completeMission(round500(200000 * (0.5 + 0.5 * m.data.comfort / 100)) + tip, 4, tip ? '(propina en dólares 💵)' : '');
  };
  return m;
}

function missionRumba(giver) {
  const club = poi('club');
  const atm = World.pois.filter(p => p.type === 'atm').sort((a, b) => dist(a.x, a.y, giver.x, giver.y) - dist(b.x, b.y, giver.x, giver.y))[0];
  const tienda = randomSidewalkPoint((d, x, y) => d === 'C' && dist(x, y, atm.x, atm.y) > 450 && dist(x, y, atm.x, atm.y) < 1300) || randomSidewalkPoint(d => d === 'C');
  const parche = randomSidewalkPoint((d, x, y) => d === 'C' && dist(x, y, tienda.x, tienda.y) > 450 && dist(x, y, tienda.x, tienda.y) < 1400) || randomSidewalkPoint(d => d === 'C');
  const deadline = 23 * 60 + 30;
  const m = mkMission('rumba', { timer: (deadline - G.minutes) / MIN_PER_SEC, data: {} });
  m.timerMax = m.timer;
  m.timeoutText = 'Cerraron la puerta de la discoteca 😢';
  let friends = [];
  m.steps = [
    { x: atm.x, y: atm.y, r: 32, text: 'Saca plata del cajero 🏧', onReach() { floater(atm.x, atm.y - 20, '🏧 Retiro listo', '#90caf9'); } },
    { x: tienda.x, y: tienda.y, r: 34, stop: true, text: 'Compra las polas en la tienda ($15.000)', onReach() {
      if (G.money < 15000) { failMission('No te alcanzó ni pa\' las polas'); return; }
      G.money -= 15000; floater(tienda.x, tienda.y - 20, '🍺 -$15.000', '#ffd54f');
    } },
    { x: parche.x, y: parche.y, r: 40, stop: true, text: 'Recoge al parche 🎉',
      onEnter() {
        friends = [0, 1, 2].map(k => { const f = new Ped({ x: parche.x + (k - 1) * 12, y: parche.y, mode: 'dance' }); f.keep = true; f.umbrella = null; G.peds.push(f); return f; });
      },
      onReach() { friends.forEach(f => { f.keep = false; f.mode = 'gone'; }); bubble(G.player, '¡Uyyy, llegó el que era! 🎉'); } },
    { x: club.x, y: club.y, r: 46, stop: true, text: 'Llega a la Discoteca Galáctica (Zona T) antes de las 11:30 p.m.',
      check: () => G.player.energy >= 20, checkHint: 'Estás muy cansado: come algo antes de entrar a rumbear' },
  ];
  m.extra = () => `🕚 Cierran puertas: 11:30 p.m. · ⚡ ${Math.round(G.player.energy)}`;
  m.cleanup = () => friends.forEach(f => { f.keep = false; f.mode = 'gone'; });
  m.onDone = () => {
    const vip = !!G.clothes.pinta;
    if (!vip) {
      if (G.money < 40000) { failMission('No te alcanzó para el cover 😢'); return; }
      G.money -= 40000;
    }
    G.player.energy = Math.max(5, G.player.energy - 25);
    unlock('rumba');
    G.clubNight = G.day;
    fadeTransition(() => { advanceTime(((27 * 60) - G.minutes) % 1440); });
    completeMission(60000, vip ? 12 : 8, vip ? 'Entraste VIP 😎 · Le ganaste al parche en el tejo' : 'Le ganaste al parche en el tejo 🎯');
  };
  return m;
}

function missionHustle(giver) {
  const g = pick(GOODS.filter(x => x.id !== 'mango'));
  const cap = Math.max(6, G.player.onFoot ? 6 : G.player.vehicle.spec.cap);
  const qty = Math.min(cap, randi(3, 6));
  const buyer = randomSidewalkPoint((d, x, y) => districtUnlocked(d) && d !== 'D' && dist(x, y, giver.x, giver.y) > 1300 && dist(x, y, giver.x, giver.y) < 3600);
  if (!buyer) return null;
  const unit = round500(g.base * rand(1.75, 2.1));
  const man = Math.abs(buyer.x - giver.x) + Math.abs(buyer.y - giver.y);
  const client = pick(CLIENT_NAMES), addr = addressOf(buyer.x, buyer.y);
  const mk = World.pois.filter(q => q.type === 'market').sort((a, b) => dist(a.x, a.y, giver.x, giver.y) - dist(b.x, b.y, giver.x, giver.y))[0];
  const m = mkMission('hustle', { timer: Math.round(man / 140 + 70), data: { g, qty, unit } });
  m.timerMax = m.timer;
  m.steps = [
    { cond: () => (G.inv[g.id] || 0) >= qty, x: mk.x, y: mk.y, text: `Consigue ${qty} × ${g.icon} ${g.n} (en cualquier mercado 💰)` },
    { x: buyer.x, y: buyer.y, r: 36, stop: true, text: `Llévale la mercancía a ${client}: ${addr}`,
      check: () => (G.inv[g.id] || 0) >= qty, checkHint: `Te faltan ${g.n.toLowerCase()}`,
      onReach() {
        const cost = (G.invCost[g.id] || g.base) * qty;
        G.inv[g.id] -= qty;
        G.stats.hustle += qty * unit - cost;
        if (G.stats.hustle >= 500000) unlock('hustler');
      } },
  ];
  m.extra = () => `${g.icon} Tienes ${G.inv[g.id] || 0}/${qty} · Pagan ${fmtMoney(unit)} c/u`;
  m.onDone = () => completeMission(qty * unit, 2);
  return m;
}

function missionDiluvio() {
  const m = mkMission('diluvio', { timer: 210, timerMax: 210, data: { n: 0 } });
  let prev = { x: G.player.x, y: G.player.y };
  const names = ['Doña Rubiela', 'el profe Hernán', 'Yesenia', 'Don Efraín', 'la niña Sofía', 'Brayan'];
  const peds = [];
  for (let k = 0; k < 3; k++) {
    const a = randomSidewalkPoint((d, x, y) => districtUnlocked(d) && dist(x, y, prev.x, prev.y) > 450 && dist(x, y, prev.x, prev.y) < 1400);
    const b = randomSidewalkPoint((d, x, y) => districtUnlocked(d) && dist(x, y, a.x, a.y) > 800 && dist(x, y, a.x, a.y) < 2200);
    if (!a || !b) continue;
    const name = names[(k + G.day) % names.length];
    let ped = null;
    m.steps.push({ x: a.x, y: a.y, r: 46, needSeats: true, stop: true, stopText: 'recoger a ' + name, text: `Recoge a ${name} (varado/a en ${addressOf(a.x, a.y)})`,
      onEnter() { ped = new Ped({ x: a.x, y: a.y, mode: 'static', look: randomLook() }); ped.keep = true; ped.umbrella = pick(UMBRELLAS); ped.icon = '🆘'; G.peds.push(ped); peds.push(ped); },
      onReach() { if (ped) { ped.keep = false; ped.mode = 'gone'; } bubble(G.player, '¡Gracias, mijo! Casi me lleva el agua'); } });
    m.steps.push({ x: b.x, y: b.y, r: 42, stop: true, stopText: 'dejar a ' + name, text: `Lleva a ${name} a ${addressOf(b.x, b.y)}`,
      onReach() { addMoney(35000); G.rep += 1; m.data.n++; } });
    prev = b;
  }
  m.onStart = () => { setWeather('tormenta', 300); G.forceStorm = true; notify('⛈️ ¡El diluvio!', 'Calles como jabón y trancones por todo lado.', '#64b5f6'); };
  m.extra = () => `🆘 Rescatados: ${m.data.n}/3`;
  m.cleanup = () => { G.forceStorm = false; G.weatherT = 60; peds.forEach(p => { p.keep = false; p.mode = 'gone'; }); };
  m.onDone = () => { unlock('flood'); completeMission(80000, 6, 'Eres el héroe del aguacero'); };
  return m;
}

function missionVolada(giver) {
  const spots = World.parking.filter(s => { const d = districtAt(s.x, s.y); return districtUnlocked(d) && d !== 'A' && dist(s.x, s.y, giver.x, giver.y) > 900 && dist(s.x, s.y, giver.x, giver.y) < 2200 && !G.vehicles.some(v => dist(v.x, v.y, s.x, s.y) < 30); });
  const spot = pick(spots);
  const garage = randomSidewalkPoint((d, x, y) => districtUnlocked(d) && spot && dist(x, y, spot.x, spot.y) > 2200 && dist(x, y, spot.x, spot.y) < 4200);
  if (!spot || !garage) return null;
  const m = mkMission('volada', { data: {} });
  m.onStart = () => {
    const car = new Vehicle('sport', spot.x, spot.y, spot.a, { mode: 'physics', driver: null, color: '#ff1744', mission: true });
    G.vehicles.push(car); m.data.car = car;
  };
  m.steps = [
    { x: spot.x, y: spot.y, cond: () => G.player.vehicle === m.data.car, text: 'Ve por el deportivo rojo y súbete (F)',
      onReach() { addWanted(2, '¡Sonó la alarma del carro!'); } },
    { x: garage.x, y: garage.y, r: 52, stop: true, stopText: 'entrar al taller', text: 'Pierde a la policía y entra al taller del Flaco',
      check: () => G.player.vehicle === m.data.car && G.wanted === 0,
      checkHint: 'Pierde a la policía primero (sin estrellas) y llega en el deportivo' },
  ];
  m.update = () => {
    if (m.data.car && m.data.car.wrecked) failMission('Volviste nada el carro');
    if (m.idx === 1 && G.wanted > 0) m.extraHint = true;
  };
  m.extra = () => m.data.car ? `🚗 Estado del carro: ${Math.round(m.data.car.hp / m.data.car.spec.hp * 100)}%` : '';
  m.cleanup = () => {
    const car = m.data.car; if (!car) return;
    if (G.player.vehicle === car) exitVehicle();
    car.mission = false;
    if (G.player.vehicle !== car) G.vehicles = G.vehicles.filter(v => v !== car);
  };
  m.onDone = () => completeMission(650000, 7, 'El Flaco quedó contento 🤝');
  return m;
}

function canTakeMission(type, verbose) {
  const info = MISSION_INFO[type];
  if (G.rep < info.rep) return `Necesitas ${info.rep} ⭐ de reputación`;
  if (G.mission) return 'Termina primero tu misión actual';
  if (type === 'rumba') { const h = G.minutes / 60; if (!(h >= 18 && h < 22)) return 'El parche sale de 6:00 p.m. a 10:00 p.m.'; if (G.money < 70000) return 'Necesitas mínimo $70.000 para la rumba'; }
  if (type === 'diluvio' && G.weather === 'tormenta') return 'Ya está diluviando, mijo';
  return null;
}

// ==========================================================================
// EVENTOS ALEATORIOS
// ==========================================================================
const EVENT_DEFS = [
  { id: 'rain', get w() { return CITY.rain * 6; }, ok: () => G.weather === 'sol' || G.weather === 'nublado', run() { setWeather('lluvia', rand(140, 240)); notify('🌧️ ¡Se largó el aguacero!', 'Calles resbalosas y tráfico pesado. Los domicilios pagan +30%.', '#64b5f6'); } },
  { id: 'jam', w: 2, ok: () => true, run: () => eventJam(false) },
  { id: 'phone', w: 1.2, ok: () => G.phone > 0 && G.player.onFoot && !G.mission, run: eventThief },
  { id: 'checkpoint', w: 1.4, ok: () => !G.events.checkpoint, run: eventCheckpoint },
  { id: 'bonus', w: 1.4, ok: () => G.events.bonus <= 0, run() { G.events.bonus = 120; notify('🛵 Bono de domicilios x2', 'Durante 2 minutos los domicilios pagan doble.', '#ffab40'); } },
  { id: 'money', w: 1.3, ok: () => true, run: eventMoney },
  { id: 'closed', w: 1.3, ok: () => !G.events.closed, run: eventClosed },
  { id: 'festival', w: 1, ok: () => !G.events.festival, run: eventFestival },
  { id: 'strike', w: 0.9, ok: () => G.events.strike <= 0, run: () => eventJam(true) },
];

function updateEvents(dt) {
  const E = G.events;
  if (E.bonus > 0) E.bonus -= dt;
  if (E.strike > 0) E.strike -= dt;
  if (E.jam) { E.jam.t -= dt; if (E.jam.t <= 0) E.jam = null; }
  const p = G.player;
  if (E.checkpoint) {
    const c = E.checkpoint;
    c.t -= dt; c.cd -= dt;
    if (!p.onFoot && c.cd <= 0 && dist(p.x, p.y, c.x, c.y) < 72) {
      c.cd = 8;
      const sp = Math.abs(p.vehicle.speed);
      if (sp > 100) { addWanted(2, '¡Te volaste el retén!'); makeCop(c.car); }
      else if (p.vehicle.stolen) { addWanted(2, 'Vehículo con denuncia de robo'); makeCop(c.car); }
      else if (!c.ok) { c.ok = true; G.rep += 1; toast('👮 "Todo en regla, siga." +1 ⭐'); }
    }
    if (c.t <= 0) { c.car.persist = false; E.checkpoint = null; }
  }
  if (E.closed) {
    E.closed.t -= dt;
    if (E.closed.t <= 0) { for (const i of E.closed.tiles) World.dyn[i] = 0; World.closed.delete(E.closed.key); E.closed = null; toast('🚧 Ya abrieron la vía'); }
  }
  if (E.festival) {
    const f = E.festival;
    f.t -= dt;
    if (!f.done && p.onFoot && dist(p.x, p.y, f.x, f.y) < 110) {
      f.done = true; p.energy = Math.min(100, p.energy + 30); G.rep += 3;
      notify('🎸 ¡Qué toque tan bueno!', '+30 energía · +3 ⭐ reputación', '#e040fb'); Sound.sfx('success');
    }
    if (Math.random() < dt * 4 && dist(p.x, p.y, f.x, f.y) < 700) addFx('note', f.x + rand(-60, 60), f.y + rand(-50, 50), rand(-10, 10), -30, 1.5);
    if (f.t <= 0) { f.dancers.forEach(d => { d.keep = false; d.mode = 'gone'; }); E.festival = null; }
  }
  G.eventT -= dt;
  if (G.eventT <= 0) {
    G.eventT = rand(50, 95);
    const opts = EVENT_DEFS.filter(e => e.ok());
    let tot = opts.reduce((s, e) => s + e.w, 0), r = Math.random() * tot;
    for (const e of opts) { r -= e.w; if (r <= 0) { e.run(); break; } }
  }
}

/** Busca una cuadra cerca del jugador (y fuera de barrios bloqueados). */
function edgeNear(minD, maxD) {
  const p = G.player;
  const opts = World.edges.filter(e => {
    const mx = e.h ? e.i * PT + 304 : e.i * PT + 48, my = e.h ? e.j * PT + 48 : e.j * PT + 304;
    const d = dist(mx, my, p.x, p.y);
    return d > minD && d < maxD && canEnter(mx, my);
  });
  if (!opts.length) return null;
  const e = pick(opts);
  return { e, x: e.h ? e.i * PT + 304 : e.i * PT + 48, y: e.h ? e.j * PT + 48 : e.j * PT + 304 };
}

function eventJam(strike) {
  const r = edgeNear(250, 800); if (!r) return;
  const { e } = r;
  const base = e.h ? e.i * PT : e.j * PT;
  let made = 0;
  for (const dir of e.h ? [0, 2] : [1, 3]) {
    for (let s = base + 130; s < base + PT - 30; s += 46) {
      const x = e.h ? s : laneCoord(dir, e.i), y = e.h ? laneCoord(dir, e.j) : s;
      if (G.vehicles.some(o => Math.abs(o.x - x) < 36 && Math.abs(o.y - y) < 36)) continue;
      if (dist(x, y, G.player.x, G.player.y) < 60) continue;
      const v = spawnTrafficOn(e, dir, s, strike ? 'taxi' : randomTrafficType());
      v.jamT = strike ? 70 : rand(35, 50); made++;
    }
  }
  G.events.jam = { x: r.x, y: r.y, t: strike ? 70 : 45 };
  if (strike) { G.events.strike = 120; notify('🚕 Paro de taxistas', 'Taxis bloqueando la vía. Los domicilios pagan +50%.', '#ffd21f'); }
  else notify('🚦 Trancón adelante', `Bloqueo en ${addressOf(r.x, r.y)}. Busca otra ruta.`, '#ffab40');
}

function eventThief() {
  const p = G.player;
  for (let k = 0; k < 10; k++) {
    const a = rand(0, TAU), x = p.x + Math.cos(a) * 28, y = p.y + Math.sin(a) * 28;
    if (!circleFree(x, y, 5)) continue;
    const t = new Ped({ x, y, mode: 'thief', look: { skin: pick(SKINS), hair: '#b71c1c', shirt: '#b71c1c', pants: '#212121' } });
    t.thiefT = 22; t.stolenPhone = G.phone; t.umbrella = null; t.keep = true; t.icon = '📱';
    G.phone = 0;
    G.peds.push(t);
    notify('📱 ¡Le robaron el celular!', 'Persigue al de la capucha roja antes de que se vuele.', '#ff5252');
    Sound.sfx('deny');
    return;
  }
}

function eventCheckpoint() {
  const r = edgeNear(350, 900); if (!r) return;
  const { e } = r;
  const cx = r.x, cy = r.y;
  // Patrulla parqueada sobre el andén, al lado de la vía (no bloquea el carril)
  let car = null;
  for (const off of [-64, 64]) {
    const x = e.h ? cx + 50 : cx + off, y = e.h ? cy + off : cy + 50;
    const c = new Vehicle('police', x, y, e.h ? 0 : Math.PI / 2, { mode: 'physics', driver: 'post' });
    if (!vehicleBlocked(c, x, y, c.angle)) { car = c; break; }
  }
  if (!car) return;
  car.persist = true;
  G.vehicles.push(car);
  G.events.checkpoint = { x: cx, y: cy, h: e.h, t: 100, cd: 0, car, ok: false };
  notify('👮 Retén policial', `En ${addressOf(cx, cy)}. Pasa despacio… y ojalá no en carro robado.`, '#42a5f5');
}

function eventMoney() {
  const p = G.player;
  for (let k = 0; k < 20; k++) {
    const a = rand(0, TAU), d = rand(120, 280), x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d;
    const t = tileAtPx(x, y);
    if ((t === TILE.SIDEWALK || t === TILE.PLAZA) && canEnter(x, y)) {
      G.pickups.push({ x, y, amount: 20000, t: 70, kind: 'cash' });
      notify('💵 ¡Hay plata tirada cerca!', 'Alguien perdió $20.000. Búscalos en el minimapa.', '#69f0ae');
      return;
    }
  }
}

function eventClosed() {
  const r = edgeNear(250, 900); if (!r) return;
  const { e } = r;
  const tiles = [];
  if (e.h) { const tx = e.i * P + 9; for (let k = 0; k < RW; k++) tiles.push((e.j * P + k) * MW + tx); }
  else { const ty = e.j * P + 9; for (let k = 0; k < RW; k++) tiles.push(ty * MW + e.i * P + k); }
  // No cerrar encima de alguien
  for (const i of tiles) {
    const x = (i % MW + 0.5) * T, y = (Math.floor(i / MW) + 0.5) * T;
    if (G.vehicles.some(v => dist(v.x, v.y, x, y) < 40) || dist(G.player.x, G.player.y, x, y) < 60) return;
  }
  for (const i of tiles) World.dyn[i] = 1;
  const key = (e.h ? 'h' : 'v') + e.i + ',' + e.j;
  World.closed.add(key);
  G.events.closed = { key, tiles, t: 100, x: r.x, y: r.y };
  notify('🚧 Vía cerrada', `Obras en ${addressOf(r.x, r.y)}. ¡Como siempre!`, '#ff9800');
}

function eventFestival() {
  const opts = Object.entries(PARKS).map(([k, v]) => { const [bi, bj] = k.split(',').map(Number); return { name: v.name, x: (bi * P + RW + 6.5) * T, y: (bj * P + RW + 6.5) * T, d: DISTRICT_GRID[bj][bi] }; })
    .filter(o => districtUnlocked(o.d));
  if (!opts.length) return;
  const o = pick(opts);
  const dancers = [];
  for (let k = 0; k < 14; k++) {
    const a = rand(0, TAU), r = rand(20, 80), x = o.x + Math.cos(a) * r, y = o.y + Math.sin(a) * r;
    if (!circleFree(x, y, 5)) continue;
    const d = new Ped({ x, y, mode: 'dance' }); d.keep = true; d.umbrella = null; dancers.push(d); G.peds.push(d);
  }
  G.events.festival = { x: o.x, y: o.y, name: o.name, t: 150, done: false, dancers };
  notify('🎸 Festival en el ' + o.name, 'Ve a pie y disfruta: +energía y +reputación.', '#e040fb');
}

function updatePickups(dt) {
  const p = G.player;
  G.pickups = G.pickups.filter(k => {
    k.t -= dt;
    if (dist(k.x, k.y, p.x, p.y) < 24 && k.kind === 'maicena') {
      G.maicena++; Sound.sfx('coin'); floater(k.x, k.y - 16, '🎭 ¡Maicena!', '#fff59d');
      for (let i = 0; i < 6; i++) addFx('confetti', k.x, k.y, rand(-60, 60), rand(-60, 20), 1);
      return false;
    }
    if (dist(k.x, k.y, p.x, p.y) < 24) {
      addMoney(k.amount); Sound.sfx('coin');
      toast('💵 ¡Encontraste ' + fmtMoney(k.amount) + '!');
      return false;
    }
    return k.t > 0;
  });
}

// ==========================================================================
// 10. ECONOMÍA, TIENDAS Y MENÚS
// ==========================================================================
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function addMoney(n) {
  G.money += n;
  if (n > 0) G.stats.earned += n;
  if (n && G.player) floater(G.player.x, G.player.y - 28, (n > 0 ? '+' : '') + fmtMoney(n), n > 0 ? '#69f0ae' : '#ff8a80');
  if (G.money >= 10000000) unlock('rich');
}
function spend(n) {
  if (G.money < n) { Sound.sfx('deny'); toast('No te alcanza la plata 💸'); return false; }
  G.money -= n; Sound.sfx('buy'); return true;
}
function invCount() { return Object.values(G.inv).reduce((a, b) => a + b, 0); }
function invCap() { const p = G.player; return p.onFoot ? 6 : Math.max(6, p.vehicle.spec.cap); }
function marketPrice(mk, gid) {
  const g = GOOD[gid], mi = Object.keys(MARKETS).indexOf(mk), gi = GOODS.indexOf(g);
  const noise = 0.85 + h2(G.day * 13 + mi * 7, gi * 31 + 5) * 0.3;
  const rainMul = gid === 'paraguas' && G.rain > 0.3 ? 1.9 : 1;
  return g.base * MARKETS[mk].m[gid] * noise * rainMul;
}
const buyPrice = (mk, gid) => Math.round(marketPrice(mk, gid) * 1.05 / 100) * 100;
const sellPrice = (mk, gid) => Math.round(marketPrice(mk, gid) * 0.95 / 100) * 100;
function tradeBuy(gid, price) {
  if (invCount() >= invCap()) { toast('No te cabe más mercancía'); return; }
  if (!spend(price)) return;
  const have = G.inv[gid] || 0;
  G.invCost[gid] = Math.round(((G.invCost[gid] || 0) * have + price) / (have + 1));
  G.inv[gid] = have + 1;
}
function tradeSell(gid, price) {
  if (!(G.inv[gid] > 0)) return;
  G.inv[gid]--; G.money += price; G.stats.earned += price;
  G.stats.hustle += price - (G.invCost[gid] || price);
  if (G.stats.hustle >= 500000) unlock('hustler');
  Sound.sfx('coin');
}

/** Punto en la calle frente a la acera de un lugar (para dejar vehículos). */
function roadSpotNear(p) {
  const o = { N: [0, -1, 0], S: [0, 1, Math.PI], W: [-1, 0, -Math.PI / 2], E: [1, 0, Math.PI / 2] }[p.side] || [0, 1, Math.PI];
  return { x: p.x + o[0] * 32, y: p.y + o[1] * 32, a: o[2] };
}
function spawnOwnedVehicle(idx, spot) {
  const p = G.player, gv = G.garage[idx];
  if (G.outVeh) {
    if (G.outVeh === p.vehicle) { toast('Bájate primero del vehículo'); return; }
    const old = G.outVeh;
    if (G.garage[old.ownIdx]) G.garage[old.ownIdx].hp = old.hp;
    G.vehicles = G.vehicles.filter(v => v !== old);
  }
  const v = new Vehicle(gv.type, spot.x, spot.y, spot.a, { mode: 'physics', driver: null, owned: true, color: gv.color, hp: gv.hp, persist: true });
  v.ownIdx = idx;
  // Correr hacia adelante si el punto está ocupado
  for (let k = 0; k < 6; k++) {
    if (!G.vehicles.some(o => dist(o.x, o.y, v.x, v.y) < 34) && !vehicleBlocked(v, v.x, v.y, v.angle)) break;
    v.x += Math.cos(v.angle) * 36; v.y += Math.sin(v.angle) * 36;
  }
  G.vehicles = G.vehicles.filter(o => !(o.mode === 'traffic' && dist(o.x, o.y, v.x, v.y) < 40));
  G.vehicles.push(v); G.outVeh = v;
}
function buyVehicle(type, p) {
  const color = type === 'sport' ? '#ff1744' : type === 'bici' ? '#26a69a' : pick(['#1e88e5', '#e53935', '#212121', '#f5f5f5', '#43a047', '#8e24aa']);
  G.garage.push({ type, color, hp: VEH[type].hp });
  spawnOwnedVehicle(G.garage.length - 1, roadSpotNear(p));
  if (type === 'moto' || type === 'motosport') unlock('moto');
  notify(`🔑 ¡Estrenaste ${VEH[type].name}!`, 'Te espera en la calle. Súbete con F. Si lo dejas, lo sacas del garaje de tu casa.', '#69f0ae');
  Sound.sfx('success');
  saveGame(true);
}
function buyItem(it, p) {
  if (!spend(it.p)) return;
  const pl = G.player;
  if (it.e) pl.energy = Math.min(100, pl.energy + it.e);
  if (it.h) pl.health = Math.min(100, pl.health + it.h);
  if (it.e || it.h) floater(pl.x, pl.y - 26, pick(['¡Qué rico!', '¡Uff, delicioso!', '¡A lo bien!']), '#ffd54f');
  if (it.cloth) { G.clothes[it.cloth] = true; G.rep += it.rep || 0; toast(`👕 Estrenaste: ${it.n}  +${it.rep} ⭐`); }
  if (it.phone) { G.phone = Math.max(G.phone, it.phone); toast('📱 Ahora recibes domicilios con la tecla C'); }
  if (it.cool) { G.coolT = 160; toast('🧊 ¡Qué frescura! El calor no te afecta un rato'); }
  if (it.n === 'Bandeja paisa') unlock('bandeja');
  if (it.weapon) {
    G.weapons[it.weapon] = true; G.weapon = it.weapon;
    if (WEAPONS[it.weapon].start) G.ammo[it.weapon] = (G.ammo[it.weapon] || 0) + WEAPONS[it.weapon].start;
    toast(`${WEAPONS[it.weapon].icon} ${it.n} lista. Ataca con clic, Ctrl o J · Q cambia de arma`);
  }
  if (it.ammo) {
    if (it.ammo !== 'papa' && !G.weapons[it.ammo]) { G.money += it.p; toast('Primero compra el arma, mijo'); return; }
    G.ammo[it.ammo] = (G.ammo[it.ammo] || 0) + it.amount;
    if (it.ammo === 'papa') G.weapon = 'papa';
    toast(`📦 +${it.amount} · tienes ${G.ammo[it.ammo]}`);
  }
  if (it.veh) { buyVehicle(it.veh, p); return 'close'; }
}

// ---------- Sistema de menús (DOM) ----------
function openMenu(builder) { G.menu = { builder, sel: 0, bsel: 0, fresh: true }; renderMenu(); }
function closeMenu() { G.menu = null; $('#menu').hidden = true; }
function nextSel(items, i, d) {
  for (let k = 0; k < items.length; k++) {
    i = (i + d + items.length) % items.length;
    if (!items[i].section) return i;
  }
  return 0;
}
function renderMenu() {
  const m = G.menu; if (!m) return;
  const cfg = m.builder();
  if (!cfg) { closeMenu(); return; }
  m.cfg = cfg;
  const items = cfg.items;
  if (m.sel >= items.length) m.sel = Math.max(0, items.length - 1);
  if (items[m.sel] && items[m.sel].section) m.sel = nextSel(items, m.sel, 1);
  const el = $('#menu');
  el.hidden = false;
  el.innerHTML = `<div class="menu-card" style="--accent:${cfg.color || '#ffd54f'}">
    <div class="menu-head"><div class="menu-icon">${cfg.icon || ''}</div><div class="menu-ht"><div class="menu-title">${cfg.title}</div>${cfg.sub ? `<div class="menu-sub">${cfg.sub}</div>` : ''}</div><button class="menu-x" data-close="1" aria-label="Cerrar">✕</button></div>
    ${cfg.info ? `<div class="menu-info">${cfg.info}</div>` : ''}
    <div class="menu-list">${items.map((it, i) => it.section ? `<div class="menu-section">${it.section}</div>` :
      `<div class="menu-item${i === m.sel ? ' sel' : ''}${it.disabled ? ' disabled' : ''}" data-i="${i}">
        <div class="mi-main"><div class="mi-label">${it.label}</div>${it.sub ? `<div class="mi-sub">${it.sub}</div>` : ''}</div>
        ${it.buttons ? `<div class="mi-btns">${it.buttons.map((b, j) => `<button class="mi-btn${i === m.sel && j === m.bsel ? ' sel' : ''}${b.disabled ? ' disabled' : ''}" data-i="${i}" data-b="${j}">${b.label}</button>`).join('')}</div>` : it.right ? `<div class="mi-right">${it.right}</div>` : ''}
      </div>`).join('')}</div>
    <div class="menu-foot">${cfg.foot || (document.body.classList.contains('touch') ? 'Toca una opción' : '↑↓ elegir · Enter aceptar · Esc salir')}</div></div>`;
  const s = el.querySelector('.menu-item.sel');
  if (s) s.scrollIntoView({ block: 'nearest' });
}
function activate(i, b) {
  const m = G.menu; if (!m) return;
  const it = m.cfg.items[i]; if (!it || it.section) return;
  const btn = it.buttons ? it.buttons[b] : null;
  const dis = btn ? btn.disabled : it.disabled, act = btn ? btn.action : it.action;
  if (dis || !act) { Sound.sfx('deny'); if (typeof dis === 'string') toast(dis); return; }
  Sound.sfx('click');
  const r = act();
  if (G.menu !== m) return;
  if (r === 'close') closeMenu(); else renderMenu();
}
function menuInput() {
  const m = G.menu;
  if (m.fresh) { m.fresh = false; return; }
  const items = m.cfg.items;
  if (Input.hit('esc', 'back')) { closeMenu(); Sound.sfx('click'); return; }
  if (Input.hit('up')) { m.sel = nextSel(items, m.sel, -1); m.bsel = 0; renderMenu(); }
  if (Input.hit('down')) { m.sel = nextSel(items, m.sel, 1); m.bsel = 0; renderMenu(); }
  if (Input.hit('left', 'right')) {
    const it = items[m.sel];
    if (it && it.buttons) { m.bsel = clamp(m.bsel + (Input.hit('right') ? 1 : -1), 0, it.buttons.length - 1); renderMenu(); }
  }
  if (Input.hit('enter', 'e', 'space')) { activate(m.sel, m.bsel); return; }
  const sel = items.map((it, i) => it.section ? -1 : i).filter(i => i >= 0);
  for (let k = 1; k <= 9; k++) if (Input.hit(String(k)) && sel[k - 1] != null) { m.sel = sel[k - 1]; activate(m.sel, 0); return; }
}

function deliveryItems(why) {
  if (!G.offers || G.offersT <= 0 || !G.offers.length) { G.offers = genDeliveryOffers(3); G.offersT = 45; }
  const bonus = (G.events.bonus > 0 ? 2 : 1) * (G.rain > 0.4 ? 1.3 : 1) * (G.events.strike > 0 ? 1.5 : 1);
  const items = G.offers.map((o, i) => ({
    label: `${o.rest} → ${o.client}`, sub: `📍 ${o.addr} · ⏱ ${o.time} s`,
    right: fmtMoney(round500(o.pay * bonus)) + (bonus > 1 ? ' 🔥' : ''),
    disabled: why || false,
    action: () => { G.offers.splice(i, 1); startMission(missionDelivery(o)); return 'close'; },
  }));
  if (!items.length) items.push({ label: 'No hay pedidos por ahora', disabled: true });
  items.push({ label: '🔄 Ver otros pedidos', action: () => { G.offers = genDeliveryOffers(3); G.offersT = 45; } });
  return items;
}

function menuShop(p) {
  const s = SHOPS[p.shop];
  return () => ({
    title: s.name, icon: s.icon, color: s.color,
    sub: `💵 ${fmtMoney(G.money)} · ⚡ ${Math.round(G.player.energy)} · ❤️ ${Math.round(G.player.health)}`,
    items: s.items.map(it => {
      const owned = (it.cloth && G.clothes[it.cloth]) || (it.phone && G.phone >= it.phone) || (it.weapon && G.weapons[it.weapon]);
      const sub = it.desc || [it.e ? `+${it.e} ⚡ energía` : '', it.h ? `+${it.h} ❤️ salud` : '', it.cool ? '🧊 quita el calor' : '', it.ammo ? `Tienes ${G.ammo[it.ammo] || 0}` : ''].filter(Boolean).join(' · ');
      return { label: it.n, sub, right: owned ? '✔ Ya es tuyo' : fmtMoney(it.p), disabled: owned ? 'Ya lo tienes' : G.money < it.p ? 'No te alcanza la plata 💸' : false, action: () => buyItem(it, p) };
    }).concat([{ label: 'Salir', action: () => 'close' }]),
  });
}

function menuHome(p) {
  const h = HOMES[p.home];
  return () => {
    if (!G.homes[p.home]) return {
      title: h.name, icon: '🏠', color: '#4fc3f7', sub: '🏷️ En venta',
      info: `Precio: <b>${fmtMoney(h.price)}</b><br>Sin arriendo, duermes mejor (${h.sleep}% de energía) y sacas tus vehículos del garaje.`,
      items: [
        { label: 'Comprar', right: fmtMoney(h.price), disabled: G.money < h.price ? 'No te alcanza 💸' : false, action() { if (spend(h.price)) { G.homes[p.home] = true; G.home = p.home; unlock('home'); notify('🏠 ¡Casa propia!', h.name + ' ahora es tu casa principal.', '#4fc3f7'); saveGame(true); } } },
        { label: 'Salir', action: () => 'close' }],
    };
    const items = [
      { label: '😴 Dormir hasta las 7:00 a.m.', sub: `Recuperas ${h.sleep}% de energía y +30 de salud`, disabled: G.wanted > 0 ? 'No puedes dormir con la policía encima' : G.mission ? 'Termina primero tu misión' : false, action: () => { goSleep(h); return 'close'; } },
      { label: '💾 Guardar partida', action: () => { saveGame(); toast('💾 Partida guardada'); } },
      { label: '🏠 Volverla mi casa principal', disabled: G.home === p.home ? 'Ya es tu casa principal' : false, action() { G.home = p.home; toast('Ahora vives en ' + h.name); } },
      { section: '🚗 Garaje' },
    ];
    G.garage.forEach((gv, i) => items.push({
      label: VEH[gv.type].name, sub: gv.hp <= 0 ? 'Varado: llévalo al taller (allá hay grúa)' : `Estado ${Math.round(gv.hp / VEH[gv.type].hp * 100)}%`,
      right: G.outVeh && G.outVeh.ownIdx === i ? 'En la calle' : 'Sacar',
      disabled: gv.hp <= 0 ? 'Está varado' : false,
      action: () => { spawnOwnedVehicle(i, roadSpotNear(p)); toast('🔑 Te dejé el vehículo en la calle'); return 'close'; },
    }));
    if (!G.garage.length) items.push({ label: 'Todavía no tienes vehículos', sub: 'Bicis en Kennedy, motos y carros en Chapinero', disabled: true });
    items.push({ label: 'Salir', action: () => 'close' });
    return { title: h.name, icon: '🏠', color: '#4fc3f7', sub: G.home === p.home ? 'Tu casa principal' : 'Tuya', items };
  };
}
function goSleep(h) {
  fadeTransition(() => {
    const mins = (7 * 60 - G.minutes + 1440) % 1440 || 1440;
    advanceTime(mins);
    G.player.energy = Math.max(G.player.energy, h.sleep);
    G.player.health = Math.min(100, G.player.health + 30);
    saveGame(true);
    notify('☀️ ¡Buenos días!', `Día ${G.day} · ${clockStr()}`, '#ffd54f');
  });
}

function menuMarket(p) {
  const mk = MARKETS[p.market];
  return () => {
    const cap = invCap(), cnt = invCount();
    return {
      title: mk.name, icon: '💰', color: '#ffd54f', sub: `${mk.desc} · Cargas ${cnt}/${cap} · 💵 ${fmtMoney(G.money)}`,
      info: (G.rain > 0.3 ? '☂️ ¡Está lloviendo: los paraguas se venden carísimos! ' : '') + 'Compra barato, vende caro en otro barrio. Los precios cambian cada día.',
      items: GOODS.map(g => {
        const buy = buyPrice(p.market, g.id), sell = sellPrice(p.market, g.id), have = G.inv[g.id] || 0;
        return {
          label: `${g.icon} ${g.n}`, sub: `Tienes ${have}${have ? ' · te costaron ' + fmtMoney(G.invCost[g.id] || 0) + ' c/u' : ''}`,
          buttons: [
            { label: `Comprar ${fmtMoney(buy)}`, disabled: G.money < buy ? 'No te alcanza 💸' : cnt >= cap ? 'No te cabe más (un vehículo carga más)' : false, action: () => tradeBuy(g.id, buy) },
            { label: `Vender ${fmtMoney(sell)}`, disabled: have <= 0 ? 'No tienes de eso' : false, action: () => tradeSell(g.id, sell) },
          ],
        };
      }).concat([{ label: 'Salir', action: () => 'close' }]),
      foot: '↑↓ producto · ←→ comprar/vender · Enter confirmar · Esc salir',
    };
  };
}

function buildMission(p) {
  switch (p.mission) {
    case 'tmrace': return missionTMRace();
    case 'airport': return missionAirport(p);
    case 'rumba': return missionRumba(p);
    case 'hustle': return missionHustle(p);
    case 'diluvio': return missionDiluvio();
    case 'volada': return missionVolada(p);
    case 'taxi': return missionTaxi(p);
    case 'carrera': return missionCarrera(p);
    case 'pandilla': return missionPandilla(p);
    case 'silleta': return missionSilleta(p);
    case 'grafiti': return missionGrafiti(p);
    case 'vendedor': return missionVendedor(p);
    case 'guia': return missionGuia(p);
    case 'carnaval': return missionCarnaval(p);
    case 'salsa': return missionSalsa(p);
  }
  return null;
}
function menuGiver(p) {
  const info = MISSION_INFO[p.mission];
  return () => {
    const why = canTakeMission(p.mission);
    const sub = info.title + (G.rep < info.rep ? ` · 🔒 Necesitas ${info.rep} ⭐` : '');
    if (p.mission === 'delivery') return { title: p.npc, icon: info.icon, color: info.color, sub, info: info.desc + (G.phone ? '' : '<br><i>Tip: con un celular recibes pedidos en cualquier lugar (tecla C).</i>'), items: deliveryItems(why).concat([{ label: 'Salir', action: () => 'close' }]) };
    return {
      title: p.npc, icon: info.icon, color: info.color, sub, info: info.desc,
      items: [
        { label: '✅ Aceptar misión', disabled: why || false, action: () => { const m = buildMission(p); if (!m) { toast('Ahora no hay camello. Vuelve más tarde.'); return; } startMission(m); return 'close'; } },
        { label: 'Ahora no', action: () => 'close' }],
    };
  };
}

function menuPhone() {
  return () => {
    if (!G.phone) return { title: 'Sin celular', icon: '📵', color: '#90a4ae', sub: 'Cómprate uno en Celulares San Andresito (Centro).', items: [{ label: '📊 Estadísticas y logros', action: () => openMenu(menuStats()) }, { label: 'Ok', action: () => 'close' }] };
    const items = [{ section: '🛵 App de domicilios' + (G.events.bonus > 0 ? ' · BONO x2 🔥' : '') }].concat(deliveryItems(canTakeMission('delivery')));
    items.push({ section: 'Más' });
    if (G.mission) items.push({ label: '❌ Abandonar misión', sub: G.mission.title, action: () => { failMission('La abandonaste'); return 'close'; } });
    items.push({ label: '📊 Estadísticas y logros', action: () => openMenu(menuStats()) });
    items.push({ label: '💾 Guardar partida', action: () => { saveGame(); toast('💾 Partida guardada'); } });
    return { title: G.phone === 2 ? 'Smartphone' : 'Celular', icon: '📱', color: '#29b6f6', sub: `${clockStr()} · Día ${G.day} · 💵 ${fmtMoney(G.money)}`, items };
  };
}

function menuPause() {
  return () => ({
    title: 'Pausa', icon: '⏸️', color: '#ffd54f', sub: `${G.name} · Día ${G.day} · ${clockStr()}`,
    items: [
      { label: '▶️ Continuar', action: () => 'close' },
      { label: '📊 Estadísticas y logros', action: () => openMenu(menuStats()) },
      { label: '🎮 Controles', action: () => openMenu(menuControls()) },
      { label: Sound.muted ? '🔇 Sonido: apagado' : '🔊 Sonido: encendido', action: () => { Sound.setMuted(!Sound.muted); } },
      { label: Sound.radio.on ? '📻 Radio en el carro: encendida' : '📻 Radio en el carro: apagada', action: () => { Sound.radio.on = !Sound.radio.on; } },
      ...(G.mission ? [{ label: '❌ Abandonar misión', sub: G.mission.title, action: () => { failMission('La abandonaste'); return 'close'; } }] : []),
      { label: '💾 Guardar partida', action: () => { saveGame(); toast('💾 Partida guardada'); } },
      { label: '🏠 Guardar y salir al menú', action: () => { saveGame(); closeMenu(); toTitle(); return 'close'; } },
    ],
  });
}
function menuControls() {
  return () => ({
    title: 'Controles', icon: '🎮', color: '#81d4fa',
    info: `<div class="ctl-grid">
      <b>WASD / Flechas</b><span>Caminar · Manejar</span>
      <b>Shift</b><span>Correr</span>
      <b>Espacio</b><span>Freno de mano (derrapar)</span>
      <b>F</b><span>Subir / bajar de vehículos (o robarlos 👀)</span>
      <b>E</b><span>Hablar, comprar, entrar, esconderse</span>
      <b>H</b><span>Pitar</span>
      <b>C</b><span>Celular: domicilios y estadísticas</span>
      <b>M</b><span>Mapa de la ciudad (clic = destino GPS)</span>
      <b>R</b><span>Radio on/off</span>
      <b>N</b><span>Silenciar</span>
      <b>Esc / P</b><span>Pausa</span></div>`,
    items: [{ label: 'Volver', action: () => openMenu(menuPause()) }],
  });
}
function menuStats() {
  return () => {
    const s = G.stats, mins = Math.floor(s.played / 60);
    const ach = Object.entries(ACH).map(([k, a]) => ({ label: `${G.ach[k] ? a.i : '🔒'} ${a.n}`, sub: a.d, right: G.ach[k] ? '✔' : '', disabled: !G.ach[k] }));
    return {
      title: 'Estadísticas', icon: '📊', color: '#b39ddb', sub: `${G.name} · ${mins} min jugados`,
      info: `<div class="ctl-grid">
        <b>Plata ganada</b><span>${fmtMoney(s.earned)}</span>
        <b>Domicilios</b><span>${s.deliveries}</span>
        <b>Misiones</b><span>${s.missions}</span>
        <b>Ganancia negociando</b><span>${fmtMoney(s.hustle)}</span>
        <b>Huecos</b><span>${s.potholes} 🕳️</span>
        <b>Veces en la estación</b><span>${s.busted}</span>
        <b>Veces en el hospital</b><span>${s.wasted}</span>
        <b>Barrios visitados</b><span>${Object.keys(G.visited).length}</span>
        <b>Ciudades</b><span>${CITY_ORDER.filter(c => G.cityVisited[c]).map(c => CITIES[c].name).join(', ')}</span>
        <b>Armas</b><span>${ownedWeapons().map(w => WEAPONS[w].icon).join(' ')}</span>
        <b>Negocios</b><span>${Object.keys(G.biz).filter(k => G.biz[k]).map(k => BIZ[k].icon).join(' ') || '—'}</span>
        <b>Mercancía</b><span>${GOODS.filter(g => G.inv[g.id]).map(g => g.icon + G.inv[g.id]).join(' ') || '—'}</span></div>`,
      items: [{ section: `🏆 Logros (${Object.keys(G.ach).length}/${Object.keys(ACH).length})` }, ...ach, { label: 'Volver', action: () => G.state === 'play' ? openMenu(menuPause()) : 'close' }],
    };
  };
}

function menuSimple(title, icon, color, info, items) { return () => ({ title, icon, color, info, items: items.concat([{ label: 'Salir', action: () => 'close' }]) }); }

function menuMechanic(p) {
  return () => {
    const v = G.player.vehicle, items = [];
    if (v) {
      const miss = v.spec.hp - v.hp, cost = round500(miss * (v.spec.two ? 900 : 1300));
      items.push({ label: `🔧 Reparar ${v.spec.name}`, sub: `Estado ${Math.round(v.hp / v.spec.hp * 100)}%`, right: miss < 1 ? 'Está bien' : fmtMoney(cost), disabled: miss < 1 ? 'No necesita arreglo' : G.money < cost ? 'No te alcanza 💸' : false, action() { if (spend(cost)) { v.hp = v.spec.hp; v.wrecked = false; toast('🔧 ¡Quedó como nuevo!'); } } });
    } else items.push({ label: 'Trae un vehículo para arreglarlo', disabled: true });
    G.garage.forEach((gv, i) => {
      if (gv.hp > 0) return;
      const cost = round500(VEH[gv.type].hp * (VEH[gv.type].two ? 900 : 1300) + 60000);
      items.push({ label: `🚚 Grúa + reparación: ${VEH[gv.type].name}`, sub: 'Lo dejamos como nuevo en tu garaje', right: fmtMoney(cost), disabled: G.money < cost ? 'No te alcanza 💸' : false, action() {
        if (!spend(cost)) return;
        gv.hp = VEH[gv.type].hp;
        if (G.outVeh && G.outVeh.ownIdx === i && G.outVeh !== G.player.vehicle) { G.vehicles = G.vehicles.filter(o => o !== G.outVeh); G.outVeh = null; }
        toast('🔧 Listo, está en tu garaje');
      } });
    });
    return { title: 'Taller El Mono', icon: '🔧', color: '#ffb74d', sub: '"Eso se lo dejo como nuevo, patrón."', items: items.concat([{ label: 'Salir', action: () => 'close' }]) };
  };
}
function menuCarwash() {
  return () => {
    const v = G.player.vehicle, items = [];
    const cost = 60000 * G.wanted;
    if (!v) items.push({ label: 'Tienes que venir en un vehículo', disabled: true });
    else if (G.wanted > 0) items.push({ label: '🧽 Lavada + placas nuevas', sub: 'La policía pierde tu rastro de una', right: fmtMoney(cost), disabled: G.money < cost ? 'No te alcanza 💸' : false, action() { if (spend(cost)) { G.wanted = 0; G.unseen = 0; v.stolen = false; G.peakWanted = 0; notify('🧽 Placas nuevas', 'La policía ya no te busca.', '#4dd0e1'); return 'close'; } } });
    else items.push({ label: '🧽 Lavada sencilla', sub: 'Brillante como nuevo', right: '$8.000', disabled: G.money < 8000 ? 'No te alcanza 💸' : false, action() { if (spend(8000)) { v.stolen = false; toast('✨ ¡Quedó brillante!'); return 'close'; } } });
    return { title: 'Lavadero y Placas', icon: '🧽', color: '#4dd0e1', sub: 'Aquí no se pregunta nada…', items: items.concat([{ label: 'Salir', action: () => 'close' }]) };
  };
}
function menuBusiness(p) {
  const b = BIZ[p.biz];
  return () => G.biz[p.biz]
    ? { title: b.name, icon: b.icon, color: '#81c784', sub: 'Tu negocio', info: `Te deja alrededor de <b>${fmtMoney(b.income)}</b> cada medianoche.`, items: [{ label: 'Saludar a los empleados 👋', action: () => { toast('"¡Todo bien, patrón!"'); return 'close'; } }, { label: 'Salir', action: () => 'close' }] }
    : { title: b.name, icon: b.icon, color: '#81c784', sub: '🏷️ Se vende', info: `Precio: <b>${fmtMoney(b.price)}</b><br>Deja alrededor de <b>${fmtMoney(b.income)}</b> cada día.`, items: [
      { label: 'Comprar negocio', right: fmtMoney(b.price), disabled: G.money < b.price ? 'No te alcanza 💸' : false, action() { if (spend(b.price)) { G.biz[p.biz] = true; G.rep += 5; unlock('biz'); notify('🏪 ¡Ahora eres empresario!', b.name + ' · +5 ⭐', '#81c784'); saveGame(true); } } },
      { label: 'Salir', action: () => 'close' }] };
}
function menuStation(p) {
  return () => ({
    title: p.name, icon: '🚉', color: CITY.troncal.color, sub: `${CITY.troncal.name} · Pasaje: ${fmtMoney(CITY.troncal.fare)} · Hora pico todo el día 😅`,
    items: World.stations.filter(s => s !== p).map(s => {
      const ok = districtUnlocked(districtAt(s.x, s.y));
      return { label: s.station, sub: DISTRICTS[districtAt(s.x, s.y)].name, right: ok ? fmtMoney(CITY.troncal.fare) : '🔒', disabled: !ok ? 'Ese barrio está bloqueado' : G.money < CITY.troncal.fare ? 'No te alcanza ni pal pasaje' : false, action: () => { rideTM(s); return 'close'; } };
    }).concat([{ label: 'Salir', action: () => 'close' }]),
  });
}
function rideTM(s) {
  if (!spend(CITY.troncal.fare)) return;
  if (G.mission && G.mission.type === 'tmrace') { failMission('¡Hacer trampa montándote al TM no vale!'); }
  fadeTransition(() => {
    const p = G.player;
    p.x = s.x; p.y = s.y; cam.x = s.x; cam.y = s.y;
    advanceTime(25); p.energy = Math.max(0, p.energy - 5);
    G.vehicles = G.vehicles.filter(v => v.owned || v.persist || v.mission);
    G.peds = G.peds.filter(pd => pd.keep);
    const r = Math.random();
    if (r < 0.12 && G.money > 10000) { G.money -= 10000; notify('🚌 Llegaste a ' + s.station, 'En el bus te sacaron $10.000 del bolsillo 😤', '#ff8a80'); }
    else if (r < 0.25) { p.energy = Math.min(100, p.energy + 8); notify('🚌 Llegaste a ' + s.station, 'Un vendedor te regaló un bon bon bum: +8 ⚡', '#69f0ae'); }
    else notify('🚌 Llegaste a ' + s.station, '¡Qué apretujada! 25 minutos parado.', '#ef9a9a');
  });
}

function nearestPOI() {
  const p = G.player;
  let best = null, bd = 1e9;
  for (const q of World.pois) {
    if (q.type === 'hide' && G.wanted === 0) continue;
    const d = dist(q.x, q.y, p.x, p.y), r = q.type === 'airport' ? 64 : p.onFoot ? 34 : 50;
    if (d < r && d < bd) { bd = d; best = q; }
  }
  return best;
}
const VEHICLE_OK = new Set(['home', 'giver', 'mechanic', 'carwash', 'airport', 'market']);
function poiVerb(q) {
  return { home: 'Entrar a', shop: 'Comprar en', hospital: 'Entrar al', police: 'Entrar a la', mechanic: 'Entrar al', carwash: 'Entrar al', market: 'Negociar en', business: 'Ver', giver: 'Hablar con', club: 'Entrar a', atm: 'Usar el', hide: 'Esconderse en el', airport: '', station: 'Entrar a la' }[q.type] || '';
}
function interact(q) {
  const p = G.player;
  if (!p.onFoot && !VEHICLE_OK.has(q.type)) { toast('Bájate del vehículo (F) para entrar'); return; }
  switch (q.type) {
    case 'shop': openMenu(menuShop(q)); break;
    case 'home': openMenu(q.home === 'hotel' ? menuHotel(q) : menuHome(q)); break;
    case 'market': openMenu(menuMarket(q)); break;
    case 'giver': openMenu(menuGiver(q)); break;
    case 'mechanic': openMenu(menuMechanic(q)); break;
    case 'carwash': openMenu(menuCarwash(q)); break;
    case 'business': openMenu(menuBusiness(q)); break;
    case 'station': openMenu(menuStation(q)); break;
    case 'hospital': openMenu(menuSimple(q.name, '🏥', '#ef5350', 'Te atienden rapidito (bueno, más o menos).', [
      { label: 'Consulta y curación completa', right: '$40.000', disabled: G.player.health >= 100 ? 'Estás sano' : G.money < 40000 ? 'No te alcanza 💸' : false, action() { if (spend(40000)) { G.player.health = 100; toast('🏥 ¡Como nuevo!'); return 'close'; } } }])); break;
    case 'police': openMenu(menuSimple(q.name, '🚓', '#42a5f5', 'Aquí te traen cuando te coge la tomba. Mejor no volver… 👀', [])); break;
    case 'atm': openMenu(menuSimple('Cajero automático', '🏧', '#90a4ae', `Saldo disponible: <b>${fmtMoney(G.money)}</b><br>Comisión por consultar: $0 (milagro).`, [])); break;
    case 'club': openMenu(menuSimple('Discoteca Galáctica', '🪩', '#e040fb', 'Abre de 9:00 p.m. a 3:00 a.m. Cover: $40.000.', [
      { label: '💃 Entrar a rumbear', sub: '+3 ⭐ reputación, -30 ⚡ energía', right: G.clothes.pinta ? 'VIP' : '$40.000', disabled: !(G.minutes >= 21 * 60 || G.minutes < 3 * 60) ? 'Está cerrado' : G.clubNight === G.day ? 'Ya rumbeaste hoy' : G.player.energy < 35 ? 'Estás muy cansado' : (!G.clothes.pinta && G.money < 40000) ? 'No te alcanza 💸' : false,
        action() { if (!G.clothes.pinta && !spend(40000)) return; G.clubNight = G.day; G.rep += 3; G.player.energy -= 30; fadeTransition(() => advanceTime(150)); toast('🪩 ¡Qué rumba tan buena! +3 ⭐'); return 'close'; } }])); break;
    case 'hide':
      p.hidden = true; p.hideT = 0; toast('🌿 Te escondiste… quieto y sin hacer ruido'); break;
    case 'airport': openMenu(menuFlights()); break;
  }
}

// ==========================================================================
// 11. HUD, NOTIFICACIONES, MINIMAPA Y MAPA
// ==========================================================================
function isTouch() { return document.body.classList.contains('touch'); }
function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = text;
  pushToast(el, 3200);
}
function notify(title, text, color = '#ffd54f') {
  const el = document.createElement('div');
  el.className = 'toast card'; el.style.setProperty('--c', color);
  el.innerHTML = `<b>${title}</b><span>${text}</span>`;
  pushToast(el, 5200);
  Sound.sfx('notify');
}
function pushToast(el, ms) {
  const box = $('#toasts');
  box.appendChild(el);
  const max = isTouch() ? 2 : 5;
  while (box.children.length > max) box.removeChild(box.firstChild);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, ms);
}
let bannerTimer = 0;
function banner(title, sub, color, big) {
  const el = $('#banner');
  el.hidden = false; el.className = big ? 'big' : '';
  el.style.setProperty('--c', color || '#ffd54f');
  el.querySelector('.b-title').textContent = title;
  el.querySelector('.b-sub').textContent = sub || '';
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.hidden = true; }, big ? 3600 : 3000);
}
function districtBanner(d) {
  const el = $('#district-banner'), info = DISTRICTS[d];
  el.hidden = false;
  el.style.setProperty('--c', info.color);
  el.querySelector('.db-name').textContent = info.name;
  el.querySelector('.db-tag').textContent = info.tagline;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 2800);
}
function floater(x, y, text, color) { G.floaters.push({ x, y, text, color, t: 1.5 }); }
function bubble(ent, text) { G.bubbles = G.bubbles.filter(b => b.ent !== ent); G.bubbles.push({ ent, text, t: 3 }); }
function addFx(type, x, y, vx, vy, life) { if (G.fx.length < 400) G.fx.push({ type, x, y, vx, vy, t: life, max: life }); }
function addSkid(v) {
  const c = Math.cos(v.angle), s = Math.sin(v.angle), b = -v.spec.len * 0.35, w = v.spec.w * 0.35;
  G.skids.push({ x: v.x + c * b - s * w, y: v.y + s * b + c * w, a: v.angle, t: 7 }, { x: v.x + c * b + s * w, y: v.y + s * b - c * w, a: v.angle, t: 7 });
  if (G.skids.length > 260) G.skids.splice(0, 2);
}
function shake(n) { cam.shake = Math.max(cam.shake, n); }
function unlock(id) {
  if (G.ach[id] || !ACH[id]) return;
  G.ach[id] = true;
  notify(`🏆 Logro: ${ACH[id].n}`, ACH[id].d, '#ffd54f');
  Sound.sfx('achievement');
}
function checkUnlocks() {
  G.unlockedSeen = G.unlockedSeen || {};
  for (const k in DISTRICTS) {
    const d = DISTRICTS[k];
    if (d.rep > 0 && G.rep >= d.rep && !G.unlockedSeen[k] && CITY.id === 'bogota') { G.unlockedSeen[k] = true;
      if (k === 'A') setTimeout(() => notify('✈️ ¡Ya puedes viajar!', 'Desde El Dorado vuelas a Medellín, la ciudad de la eterna primavera.', '#4fc3f7'), 1500); notify(`🔓 ¡Desbloqueaste ${d.name}!`, d.tagline, d.color); minimapDirty = true; }
  }
  if (G.rep >= 100) unlock('legend');
}
function fadeTransition(fn, text) {
  const f = $('#fade');
  f.textContent = text || '';
  f.classList.add('on');
  G.fading = true;
  setTimeout(() => { fn(); f.classList.remove('on'); G.fading = false; }, 520);
}

const hudCache = {};
function setText(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; document.getElementById(id).textContent = v; } }
function setHTML(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; document.getElementById(id).innerHTML = v; } }
function setStyle(id, prop, v) { const k = id + prop; if (hudCache[k] !== v) { hudCache[k] = v; document.getElementById(id).style[prop] = v; } }
function setHidden(id, h) { const k = id + 'h'; if (hudCache[k] !== h) { hudCache[k] = h; document.getElementById(id).hidden = h; } }

function nextUnlock() {
  const all = Object.values(DISTRICTS).filter(d => d.rep > G.rep).sort((a, b) => a.rep - b.rep);
  return all[0];
}
function updateHUD() {
  const p = G.player;
  setText('h-name', G.name);
  setText('h-money', fmtMoney(G.money));
  setStyle('h-health', 'width', Math.round(p.health) + '%');
  setStyle('h-energy', 'width', Math.round(p.energy) + '%');
  document.getElementById('h-health').classList.toggle('low', p.health < 30);
  document.getElementById('h-energy').classList.toggle('low', p.energy < 20);
  setText('h-rep', String(G.rep));
  const nu = nextUnlock();
  setText('h-next', nu ? `· ${nu.name} en ${nu.rep}` : '· ¡Toda la ciudad!');
  setHTML('h-wanted', [0, 1, 2].map(i => `<i class="${i < G.wanted ? 'on' : ''}">★</i>`).join(''));
  document.getElementById('hud-left').classList.toggle('hunted', G.wanted > 0);
  setText('h-clock', clockStr());
  setText('h-day', `Día ${G.day} · ${CITY.name}`);
  const wpn = WEAPONS[G.weapon];
  setText('h-weapon', `${wpn.icon} ${wpn.n}${wpn.melee ? '' : ' · ' + (G.ammo[G.weapon] || 0)}  ${isTouch() ? '' : '(Q cambia)'}`);
  const wIcon = { sol: G.minutes > 18 * 60 || G.minutes < 6 * 60 ? '🌙 Despejado' : '☀️ Soleado', nublado: '☁️ Nublado', lluvia: '🌧️ Lluvia', tormenta: '⛈️ Tormenta' }[G.weather];
  setText('h-weather', wIcon + (G.events.bonus > 0 ? ' · 🛵x2' : '') + (G.events.strike > 0 ? ' · 🚕 Paro' : ''));
  const j = clamp(Math.round((p.y - 48) / PT), 0, BY), i = clamp(Math.round((p.x - 48) / PT), 0, BX);
  setText('mm-addr', `${DISTRICTS[districtAt(p.x, p.y)].name} · ${calleName(j)} con ${carreraName(i)}`);
  // Misión
  const m = G.mission;
  setHidden('hud-mission', !m);
  if (m) {
    const st = m.steps[m.idx];
    setText('m-title', `${m.icon} ${m.title}`);
    setText('m-text', st ? st.text : '');
    setText('m-extra', m.extra ? m.extra() : '');
    if (m.timer != null) {
      const t = Math.max(0, Math.ceil(m.timer));
      setText('m-timer', `⏱ ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`);
      document.getElementById('m-timer').classList.toggle('urgent', t <= 10);
    } else setText('m-timer', '');
    setText('m-hint', m.hint ? '⚠️ ' + m.hint : '');
    setStyle('hud-mission', 'borderColor', m.color);
  }
  // Vehículo
  const v = p.vehicle;
  setHidden('veh-box', !v);
  if (v) {
    setText('v-name', (v.owned ? '🔑 ' : v.stolen ? '🚨 ' : '') + v.spec.name);
    setText('v-speed', String(Math.round(Math.abs(v.speed) * 0.3)));
    setStyle('v-hp', 'width', Math.round(v.hp / v.spec.hp * 100) + '%');
    document.getElementById('v-hp').classList.toggle('low', v.hp < v.spec.hp * 0.3);
    setText('v-extra', Sound.radio.on ? `📻 ${STATIONS[Sound.radio.station].name} (R)` : '📻 Apagada (R)');
  }
  // Barra de escape
  setHidden('escape-bar', G.wanted <= 0);
  if (G.wanted > 0) setStyle('escape-fill', 'width', Math.round(clamp(G.escape || 0, 0, 1) * 100) + '%');
  // Sugerencia de interacción
  let prompt = '';
  if (!G.overlay && !G.menu) {
    if (p.hidden) prompt = '🌿 Escondido · E o muévete para salir';
    else {
      const q = nearestPOI();
      if (q) prompt = `<kbd>E</kbd> ${poiVerb(q)} ${q.name}`;
      else if (p.onFoot) {
        let best = null, bd = 1e9;
        for (const o of G.vehicles) { const d = dist(p.x, p.y, o.x, o.y) - o.spec.len / 2; if (d < 24 && d < bd) { bd = d; best = o; } }
        if (best && !best.spec.nodrive) prompt = `<kbd>${isTouch() ? '🚗' : 'F'}</kbd> ${best.owned ? 'Subirte a tu' : best.driver === 'npc' || best.driver === 'cop' ? '🚨 Robar el' : 'Tomar el'} ${best.spec.name.toLowerCase()}`;
      } else if (p.vehicle && Math.abs(p.vehicle.speed) < 20) prompt = `<kbd>${isTouch() ? '🚗' : 'F'}</kbd> Bajarte`;
    }
  }
  setHidden('prompt', !prompt);
  if (prompt) setHTML('prompt', prompt);
}

// ---------- Minimapa ----------
let miniBase = null, minimapDirty = true;
const TILE_MINI = ['#5a5e68', '#a39d92', null, '#4f8a3e', '#a8835e', '#3d7fb8', '#3e7a33', '#2f3238', '#8c8c88'];
function buildMiniBase() {
  miniBase = document.createElement('canvas');
  miniBase.width = MW; miniBase.height = MH;
  const g = miniBase.getContext('2d'), img = g.createImageData(MW, MH);
  const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const cache = {};
  for (let ty = 0; ty < MH; ty++) for (let tx = 0; tx < MW; tx++) {
    const t = World.tiles[ty * MW + tx];
    let c;
    if (t === TILE.BUILDING) c = shade(DISTRICTS[districtAt((tx + 0.5) * T, (ty + 0.5) * T)].color, -0.25).match(/\d+/g).map(Number);
    else {
      const troncal = t === TILE.ROAD && ((Math.floor(ty / P) === 6 && ty % P === 1) || (Math.floor(tx / P) === 4 && tx % P === 1));
      const key = troncal ? 'tr' : t;
      c = cache[key] || (cache[key] = hex(troncal ? '#a33a3a' : TILE_MINI[t]));
    }
    const i = (ty * MW + tx) * 4;
    img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}
const MM_ICONS = { home: '🏠', giver: null, market: '💰', station: '🚉', hospital: '🏥', mechanic: '🔧', carwash: '🧽', club: '🪩', airport: '✈️', business: '🏪' };
function drawMinimap(time) {
  const cvs = $('#minimap'), g = cvs.getContext('2d');
  const S = cvs.clientWidth, dpr = DPR;
  if (cvs.width !== Math.round(S * dpr)) { cvs.width = Math.round(S * dpr); cvs.height = Math.round(S * dpr); }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, S, S);
  const p = G.player, sc = S / 84;
  const ptx = p.x / T, pty = p.y / T;
  g.save();
  g.fillStyle = '#20301f'; g.fillRect(0, 0, S, S);
  g.translate(S / 2 - ptx * sc, S / 2 - pty * sc); g.scale(sc, sc);
  g.imageSmoothingEnabled = false;
  g.drawImage(miniBase, 0, 0);
  for (let bj = 0; bj < BY; bj++) for (let bi = 0; bi < BX; bi++) {
    if (!districtUnlocked(DISTRICT_GRID[bj][bi])) { g.fillStyle = 'rgba(8,8,16,.62)'; g.fillRect(bi * P + RW, bj * P + RW, 13, 13); }
  }
  if (G.gps && G.gps.length > 1) {
    g.strokeStyle = G.gpsColor || '#ffd54f'; g.lineWidth = 1.6; g.lineJoin = 'round'; g.globalAlpha = 0.9;
    g.beginPath(); g.moveTo(G.gps[0][0] / T, G.gps[0][1] / T);
    for (const pt of G.gps) g.lineTo(pt[0] / T, pt[1] / T);
    g.stroke(); g.globalAlpha = 1;
  }
  g.restore();
  const toMM = (x, y) => [S / 2 + (x / T - ptx) * sc, S / 2 + (y / T - pty) * sc];
  const inMM = (a) => a[0] > 4 && a[1] > 4 && a[0] < S - 4 && a[1] < S - 4;
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '10px sans-serif';
  for (const q of World.pois) {
    let ic = MM_ICONS[q.type];
    if (q.type === 'giver') ic = G.rep >= MISSION_INFO[q.mission].rep ? q.icon : null;
    if (q.type === 'hide' && G.wanted > 0) ic = '🌿';
    if (q.type === 'shop' && ['bicis', 'motos', 'carros', 'celulares'].includes(q.shop)) ic = q.icon;
    const a = toMM(q.x, q.y);
    if (!inMM(a)) continue;
    if (ic) { g.fillText(ic, a[0], a[1]); }
    else if (q.type === 'shop') { g.fillStyle = q.color; g.fillRect(a[0] - 1.5, a[1] - 1.5, 3, 3); }
    else if (q.type === 'giver') { g.fillStyle = '#777'; g.fillText('🔒', a[0], a[1]); }
  }
  const evs = [];
  if (G.events.jam) evs.push([G.events.jam, '⚠️']);
  if (G.events.closed) evs.push([G.events.closed, '🚧']);
  if (G.events.checkpoint) evs.push([G.events.checkpoint, '👮']);
  if (G.events.festival) evs.push([G.events.festival, '🎸']);
  for (const k of G.pickups) evs.push([k, '💵']);
  for (const [e, ic] of evs) { const a = toMM(e.x, e.y); if (inMM(a)) g.fillText(ic, a[0], a[1]); }
  if (G.outVeh && G.outVeh !== p.vehicle) { const a = toMM(G.outVeh.x, G.outVeh.y); if (inMM(a)) { g.fillStyle = '#69f0ae'; g.fillText('🔑', a[0], a[1]); } }
  const blink = (time * 4) % 2 < 1;
  for (const v of G.vehicles) {
    if (v.driver === 'cop' && v.chase) { const a = toMM(v.x, v.y); if (inMM(a)) { g.fillStyle = blink ? '#ff1744' : '#2979ff'; g.beginPath(); g.arc(a[0], a[1], 3, 0, TAU); g.fill(); } }
    if (v.race) { const a = toMM(v.x, v.y); if (inMM(a)) { g.fillStyle = '#ff5252'; g.fillText('🚌', a[0], a[1]); } }
  }
  for (const o of G.peds) if (o.mode === 'thief') { const a = toMM(o.x, o.y); if (inMM(a)) g.fillText('📱', a[0], a[1]); }
  // Objetivo
  const tg = currentTarget();
  if (tg) {
    const a = toMM(tg.x, tg.y);
    if (inMM(a)) {
      const r = 4 + Math.sin(time * 6) * 1.5;
      g.strokeStyle = tg.color; g.lineWidth = 2; g.beginPath(); g.arc(a[0], a[1], r + 2, 0, TAU); g.stroke();
      g.fillStyle = tg.color; g.beginPath(); g.arc(a[0], a[1], 3, 0, TAU); g.fill();
    } else {
      const ang = Math.atan2(a[1] - S / 2, a[0] - S / 2), R = S / 2 - 9;
      g.save(); g.translate(S / 2 + Math.cos(ang) * R, S / 2 + Math.sin(ang) * R); g.rotate(ang);
      g.fillStyle = tg.color; g.beginPath(); g.moveTo(7, 0); g.lineTo(-5, -5); g.lineTo(-5, 5); g.closePath(); g.fill(); g.restore();
    }
  }
  // Jugador
  g.save(); g.translate(S / 2, S / 2); g.rotate(p.angle);
  g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(7, 0); g.lineTo(-5, -5); g.lineTo(-2, 0); g.lineTo(-5, 5); g.closePath(); g.stroke(); g.fill();
  g.restore();
  g.fillStyle = 'rgba(255,255,255,.75)'; g.font = 'bold 10px sans-serif'; g.fillText('N', S / 2, 8);
}

function updateGPS(dt) {
  G.gpsT -= dt;
  if (G.gpsT > 0) return;
  G.gpsT = 0.6;
  const tg = currentTarget(), p = G.player;
  if (!tg) { G.gps = null; return; }
  const nodes = routeNodes(p.x, p.y, tg.x, tg.y);
  G.gps = [[p.x, p.y], ...nodes.map(n => nodeCenter(n[0], n[1])), [tg.x, tg.y]];
  if (nodes.length >= 2) {
    // Si el primer nodo queda "atrás", sáltalo
    const a = nodeCenter(nodes[0][0], nodes[0][1]), b = nodeCenter(nodes[1][0], nodes[1][1]);
    if (dist(p.x, p.y, b[0], b[1]) < dist(a[0], a[1], b[0], b[1])) G.gps.splice(1, 1);
  }
  G.gpsColor = tg.color;
}

// ---------- Mapa grande ----------
function openBigMap() { $('#bm-title').textContent = '🗺️ Mapa de ' + CITY.name; G.bigmap = true; $('#bigmap').hidden = false; bmInit(); drawBigMap(); }
function closeBigMap() { G.bigmap = false; $('#bigmap').hidden = true; }
function bigMapGeom() {
  const c = $('#bigmap-canvas'), W = c.clientWidth, H = c.clientHeight;
  if (!G.bm) bmInit();
  const sc = G.bm.sc;
  return { c, W, H, sc, ox: W / 2 - G.bm.cx * sc, oy: H / 2 - G.bm.cy * sc };
}
function drawBigMap() {
  const { c, W, H, sc, ox, oy } = bigMapGeom();
  if (c.width !== Math.round(W * DPR)) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); }
  const g = c.getContext('2d');
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.clearRect(0, 0, W, H);
  g.save(); g.translate(ox, oy); g.scale(sc, sc);
  g.imageSmoothingEnabled = false;
  g.fillStyle = '#2c5631'; g.fillRect(MW, -10, 12, MH + 20);
  g.drawImage(miniBase, 0, 0);
  for (let bj = 0; bj < BY; bj++) for (let bi = 0; bi < BX; bi++)
    if (!districtUnlocked(DISTRICT_GRID[bj][bi])) { g.fillStyle = 'rgba(8,8,16,.6)'; g.fillRect(bi * P + RW, bj * P + RW, 13, 13); }
  if (G.gps && G.gps.length > 1) {
    g.strokeStyle = G.gpsColor || '#ffd54f'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(G.gps[0][0] / T, G.gps[0][1] / T);
    for (const pt of G.gps) g.lineTo(pt[0] / T, pt[1] / T); g.stroke();
  }
  g.restore();
  // Nombres de barrios
  const acc = {};
  for (let bj = 0; bj < BY; bj++) for (let bi = 0; bi < BX; bi++) { const d = DISTRICT_GRID[bj][bi]; (acc[d] = acc[d] || []).push([bi, bj]); }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const d in acc) {
    const L = acc[d], cx = L.reduce((s, b) => s + b[0], 0) / L.length, cy = L.reduce((s, b) => s + b[1], 0) / L.length;
    const x = ox + ((cx + 0.5) * P + RW / 2) * sc, y = oy + ((cy + 0.5) * P + RW / 2) * sc;
    const info = DISTRICTS[d], locked = !districtUnlocked(d);
    g.font = `800 ${clamp(sc * 4.5, 12, 26)}px Barlow Condensed, sans-serif`;
    g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,.75)'; g.strokeText(info.name.toUpperCase(), x, y);
    g.fillStyle = locked ? '#9e9e9e' : info.color; g.fillText(info.name.toUpperCase(), x, y);
    if (locked) { g.font = `600 ${clamp(sc * 3, 10, 18)}px Barlow Condensed, sans-serif`; g.strokeText(`🔒 ${info.rep} ⭐`, x, y + sc * 8); g.fillStyle = '#eee'; g.fillText(`🔒 ${info.rep} ⭐`, x, y + sc * 8); }
  }
  g.font = `${Math.max(11, sc * 4.5)}px sans-serif`;
  for (const q of World.pois) {
    if (q.type === 'hide' || q.type === 'atm') continue;
    if (q.type === 'shop' && !['bicis', 'motos', 'carros', 'celulares', 'ropa', 'boutique'].includes(q.shop)) { g.fillStyle = q.color; g.fillRect(ox + q.x / T * sc - 2, oy + q.y / T * sc - 2, 4, 4); continue; }
    g.fillText(q.type === 'giver' && G.rep < MISSION_INFO[q.mission].rep ? '🔒' : q.icon, ox + q.x / T * sc, oy + q.y / T * sc);
  }
  if (G.outVeh && G.outVeh !== G.player.vehicle) g.fillText('🔑', ox + G.outVeh.x / T * sc, oy + G.outVeh.y / T * sc);
  const tg = currentTarget();
  if (tg) { g.fillStyle = tg.color; g.beginPath(); g.arc(ox + tg.x / T * sc, oy + tg.y / T * sc, 7, 0, TAU); g.fill(); g.strokeStyle = '#000'; g.lineWidth = 2; g.stroke(); }
  const p = G.player;
  g.save(); g.translate(ox + p.x / T * sc, oy + p.y / T * sc); g.rotate(p.angle);
  g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(10, 0); g.lineTo(-7, -7); g.lineTo(-3, 0); g.lineTo(-7, 7); g.closePath(); g.stroke(); g.fill();
  g.restore();
}

// ==========================================================================
// RENDER DEL MUNDO
// ==========================================================================
let cv, ctx, lc, lctx, VW = 800, VH = 600, DPR = 1;
const cam = { x: 0, y: 0, zoom: 1, base: 1, shake: 0 };
function onScreen(x, y, m = 0) {
  const hw = VW / 2 / cam.zoom + m, hh = VH / 2 / cam.zoom + m;
  return Math.abs(x - cam.x) < hw && Math.abs(y - cam.y) < hh;
}
function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  VW = window.innerWidth; VH = window.innerHeight;
  cv.width = Math.round(VW * DPR); cv.height = Math.round(VH * DPR);
  lc.width = cv.width; lc.height = cv.height;
  cam.base = VW < 600 ? 0.72 : VW < 1000 ? 0.88 : 1.02;
  if (G.bigmap) drawBigMap();
}
function makeSprite(size, stops) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([o, col]) => gr.addColorStop(o, col));
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return c;
}
const LIGHT = makeSprite(128, [[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(255,255,255,.65)'], [1, 'rgba(255,255,255,0)']]);
const GLOW = makeSprite(64, [[0, 'rgba(255,190,110,1)'], [1, 'rgba(255,190,110,0)']]);
const CONE = (() => {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(0, 64, 0, 0, 64, 256);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.beginPath(); g.moveTo(0, 54); g.lineTo(256, 0); g.lineTo(256, 128); g.lineTo(0, 74); g.closePath(); g.fill();
  return c;
})();

function rr(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.fill();
}

function drawPerson(g, x, y, a, look, anim, o = {}) {
  g.save(); g.translate(x, y);
  if (o.alpha != null) g.globalAlpha = Math.max(0, o.alpha);
  g.fillStyle = 'rgba(0,0,0,.28)'; g.beginPath(); g.ellipse(2, 3, 7, 5, 0, 0, TAU); g.fill();
  g.rotate(a);
  if (o.down) {
    g.fillStyle = look.pants; g.fillRect(-11, -3, 7, 6);
    g.fillStyle = look.shirt; g.fillRect(-5, -4.5, 9, 9);
    g.fillStyle = look.skin; circ(g, 7, 0, 3.2);
    g.restore(); return;
  }
  const sw = Math.sin(anim) * 3.6;
  if (look.silleta) { // silleta de flores a la espalda
    g.fillStyle = '#8d6e63'; g.fillRect(-15, -9, 9, 18);
    const fl = ['#e91e63', '#ffeb3b', '#ff5722', '#ffffff', '#9c27b0', '#f06292'];
    for (let k = 0; k < 9; k++) { g.fillStyle = fl[k % fl.length]; circ(g, -11 + (k % 3) * 3 - 2, -7 + Math.floor(k / 3) * 6, 2.8); }
  }
  g.fillStyle = look.pants; g.fillRect(-2 + sw, -4.2, 5, 3); g.fillRect(-2 - sw, 1.2, 5, 3);
  const punch = o.punch ? 5 : 0;
  g.fillStyle = look.skin; g.fillRect(-1 - sw * 0.7, -7.2, 4, 2.4); g.fillRect(-1 + sw * 0.7 + punch, 4.8, 4, 2.4);
  if (o.gun === 'bate') { g.fillStyle = '#a1887f'; g.fillRect(2 + punch, 4.6, 13, 2.6); }
  else if (o.gun && o.gun !== 'punos' && o.gun !== 'papa') { g.fillStyle = '#212121'; g.fillRect(3, 4.6, o.gun === 'escopeta' ? 13 : o.gun === 'uzi' ? 9 : 7, 2.6); }
  if (look.ruana) { g.fillStyle = '#795548'; g.beginPath(); g.ellipse(0, 0, 5.2, 8, 0, 0, TAU); g.fill(); g.fillStyle = '#d7ccc8'; g.fillRect(-4, -6, 1.2, 12); g.fillRect(1, -6, 1.2, 12); }
  else { g.fillStyle = look.shirt; g.beginPath(); g.ellipse(0, 0, 4.2, 6.6, 0, 0, TAU); g.fill(); }
  if (look.carriel) { g.fillStyle = '#6d4c41'; g.fillRect(-3, 4, 5, 4); }
  g.fillStyle = look.hair; circ(g, 0, 0, 3.7);
  g.fillStyle = look.skin; circ(g, 1.7, 0, 2.2);
  if (look.gafas) { g.fillStyle = '#111'; g.fillRect(2.4, -2, 1.4, 4); }
  if (look.marimonda) { g.fillStyle = '#e53935'; circ(g, 0.5, 0, 4.2); g.fillStyle = '#1e88e5'; circ(g, -1, -4.5, 2.6); circ(g, -1, 4.5, 2.6); g.fillStyle = '#fdd835'; g.fillRect(3, -1, 5, 2); }
  if (look.sombrero) { g.fillStyle = '#f5ecd2'; circ(g, 0, 0, 6.8); g.strokeStyle = '#2b2b2b'; g.lineWidth = 1; g.beginPath(); g.arc(0, 0, 5.2, 0, TAU); g.stroke(); g.beginPath(); g.arc(0, 0, 3.4, 0, TAU); g.stroke(); g.fillStyle = '#efe3c2'; circ(g, 0, 0, 2.2); }
  if (o.box) { g.fillStyle = '#ff6f3c'; g.fillRect(-9, -4.5, 5, 9); g.fillStyle = '#fff'; g.fillRect(-8, -1, 3, 2); }
  g.restore();
  if (o.umbrella) {
    g.fillStyle = o.umbrella; circ(g, x, y - 3, 10.5);
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1;
    g.beginPath(); for (let k = 0; k < 4; k++) { g.moveTo(x, y - 3); g.lineTo(x + Math.cos(k * 1.57 + 0.78) * 10, y - 3 + Math.sin(k * 1.57 + 0.78) * 10); } g.stroke();
  }
}

function drawTwoWheeler(g, v, hl, hw) {
  g.fillStyle = '#151515'; g.fillRect(-hl, -1.6, 6, 3.2); g.fillRect(hl - 6, -1.6, 6, 3.2);
  if (v.type === 'bici') { g.fillStyle = v.color; g.fillRect(-hl + 4, -1, 2 * hl - 8, 2); g.fillRect(hl - 7, -hw, 1.6, 2 * hw); }
  else {
    g.fillStyle = v.wrecked ? '#333' : v.color; rr(g, -hl + 3, -hw + 1, 2 * hl - 6, 2 * hw - 2, 3);
    g.fillStyle = v.colorL; g.fillRect(-hl + 6, -1.5, 6, 3);
    g.fillStyle = '#222'; g.fillRect(hl - 7, -hw, 2, 2 * hw);
    g.fillStyle = '#fff6c2'; g.fillRect(hl - 2, -1, 2, 2);
  }
  const isP = v.driver === 'player';
  const rider = isP ? playerLook() : v.driver ? v.rider : null;
  if (!rider) return;
  if (isP && G.mission && G.mission.type === 'delivery' && G.mission.data.picked) { g.fillStyle = '#ff6f3c'; g.fillRect(-hl - 1, -5, 8, 10); g.fillStyle = '#fff'; g.fillRect(-hl + 1, -1, 4, 2); }
  g.fillStyle = rider.shirt; g.beginPath(); g.ellipse(-2, 0, 4, 5.6, 0, 0, TAU); g.fill();
  g.fillStyle = rider.skin; g.fillRect(0, -5.2, 6, 2); g.fillRect(0, 3.2, 6, 2);
  g.fillStyle = v.type === 'bici' ? rider.hair : isP ? '#ffd54f' : '#263238'; circ(g, 0.5, 0, 3.5);
  if (v.type !== 'bici') { g.fillStyle = 'rgba(160,220,255,.6)'; g.fillRect(2.2, -2, 1.3, 4); }
}

function drawVehicle(g, v, time) {
  const s = v.spec, L = s.len, W = s.w, hl = L / 2, hw = W / 2;
  g.save(); g.translate(v.x, v.y); g.rotate(v.angle);
  g.fillStyle = 'rgba(0,0,0,.3)'; rr(g, -hl + 3, -hw + 4, L, W, 4);
  if (s.two) { drawTwoWheeler(g, v, hl, hw); g.restore(); return; }
  const body = v.burnt ? '#161616' : v.wrecked ? '#3b3b3b' : v.color, light = v.burnt ? '#222' : v.wrecked ? '#4a4a4a' : v.colorL, dark = v.burnt ? '#0c0c0c' : v.wrecked ? '#262626' : v.colorD;
  g.fillStyle = dark; rr(g, -hl, -hw, L, W, 4);
  g.fillStyle = body; rr(g, -hl + 1, -hw + 1, L - 2, W - 2, 3.5);
  if (v.type === 'tm' || v.type === 'bus') {
    g.fillStyle = 'rgba(20,30,45,.85)';
    for (let x = -hl + 6; x < hl - 10; x += 8) { g.fillRect(x, -hw + 1, 5, 2); g.fillRect(x, hw - 3, 5, 2); }
    g.fillStyle = light; g.fillRect(-hl + 4, -hw + 4, L - 14, W - 8);
    g.fillStyle = '#d7dde2'; for (let x = -hl + 10; x < hl - 18; x += 22) g.fillRect(x, -4, 10, 8);
    g.fillStyle = '#1c2833'; g.fillRect(hl - 6, -hw + 2, 4, W - 4);
    if (v.type === 'tm') {
      g.fillStyle = '#4a4a4a'; g.fillRect(-3, -hw, 6, W);
      g.fillStyle = '#fff'; g.font = 'bold 8px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(CITY.troncal.short, hl - 15, 0);
      if (v.race) { g.fillStyle = (time * 4) % 2 < 1 ? '#ffd600' : '#ff1744'; g.fillRect(-hl + 2, -hw + 2, 6, W - 4); }
    } else { g.fillStyle = '#fff'; g.fillRect(-hl + 4, -1, L - 14, 2); }
  } else {
    g.fillStyle = '#1c2833'; g.fillRect(hl - 11, -hw + 2, 5, W - 4); g.fillRect(-hl + 3, -hw + 2.5, 4, W - 5);
    g.fillStyle = light; g.fillRect(-hl + 8, -hw + 2.5, L - 20, W - 5);
    if (v.type === 'taxi') { g.fillStyle = '#222'; for (let x = -hl + 3; x < hl - 3; x += 4) { g.fillRect(x, -hw + 1, 2, 1.4); g.fillRect(x + 2, hw - 2.4, 2, 1.4); } g.fillStyle = '#fff'; g.fillRect(-3, -2.5, 6, 5); }
    if (v.type === 'police') {
      g.fillStyle = '#1b8a3a'; g.fillRect(-hl + 1, -hw + 1, L - 2, 2.5); g.fillRect(-hl + 1, hw - 3.5, L - 2, 2.5);
      const on = (time * 6) % 2 < 1;
      g.fillStyle = v.siren ? (on ? '#ff1744' : '#2979ff') : '#7a1c1c'; g.fillRect(-2, -hw + 3, 4, hw - 3);
      g.fillStyle = v.siren ? (on ? '#2979ff' : '#ff1744') : '#1c2f7a'; g.fillRect(-2, 0, 4, hw - 3);
    }
    if (v.type === 'sport') { g.fillStyle = '#111'; g.fillRect(-hl + 2, -1, L - 4, 2); }
  }
  g.fillStyle = '#fff6c2'; g.fillRect(hl - 2, -hw + 1.5, 2, 3); g.fillRect(hl - 2, hw - 4.5, 2, 3);
  const braking = v.mode === 'traffic' ? v.speed < 25 : v.speed < -3 || (v.driver === 'player' && Input.down('space', 'down'));
  g.fillStyle = braking ? '#ff3d3d' : '#9c1c1c'; g.fillRect(-hl, -hw + 1.5, 1.6, 3); g.fillRect(-hl, hw - 4.5, 1.6, 3);
  g.restore();
}

// Lluvia en espacio de pantalla
const drops = [];
function renderRain(dt) {
  if (G.rain < 0.02) return;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = `rgba(40,55,80,${G.rain * 0.2})`; ctx.fillRect(0, 0, VW, VH);
  const n = Math.floor(G.rain * 280 * (VW * VH) / (1280 * 720));
  while (drops.length < n) drops.push({ x: Math.random() * VW, y: Math.random() * VH, v: rand(700, 1000), l: rand(10, 20) });
  drops.length = n;
  ctx.strokeStyle = 'rgba(190,210,255,.42)'; ctx.lineWidth = 1; ctx.beginPath();
  for (const d of drops) {
    d.y += d.v * dt; d.x += d.v * 0.22 * dt;
    if (d.y > VH || d.x > VW) { d.y = -20; d.x = Math.random() * (VW + 100) - 100; }
    ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - d.l * 0.22, d.y - d.l);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(200,220,255,.3)';
  for (let k = 0; k < n / 25; k++) { ctx.beginPath(); ctx.arc(Math.random() * VW, Math.random() * VH, rand(1, 3), 0, TAU); ctx.stroke(); }
}

function worldTransform(c) {
  const z = cam.zoom * DPR;
  const sx = cam.shake ? (Math.random() - 0.5) * cam.shake : 0, sy = cam.shake ? (Math.random() - 0.5) * cam.shake : 0;
  c.setTransform(z, 0, 0, z, Math.round(VW * DPR / 2 - (cam.x + sx) * z), Math.round(VH * DPR / 2 - (cam.y + sy) * z));
}

let planeT = 0;
function render(time, dt) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#243322'; ctx.fillRect(0, 0, cv.width, cv.height);
  worldTransform(ctx);
  ctx.imageSmoothingEnabled = false;
  const hw = VW / 2 / cam.zoom, hh = VH / 2 / cam.zoom;
  const X0 = cam.x - hw - 40, X1 = cam.x + hw + 40, Y0 = cam.y - hh - 40, Y1 = cam.y + hh + 60;
  const inView = (x, y, m = 0) => x > X0 - m && x < X1 + m && y > Y0 - m && y < Y1 + m;
  // Piso
  const cx0 = Math.max(-3, Math.floor(X0 / CHUNK_PX)), cx1 = Math.min(Math.ceil(MW / CHUNK) + 2, Math.floor(X1 / CHUNK_PX));
  const cy0 = Math.max(-3, Math.floor(Y0 / CHUNK_PX)), cy1 = Math.min(Math.ceil(MH / CHUNK) + 2, Math.floor(Y1 / CHUNK_PX));
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) ctx.drawImage(getChunk(cx, cy), cx * CHUNK_PX, cy * CHUNK_PX);
  // Charcos
  if (G.wetness > 0.05) {
    ctx.globalAlpha = G.wetness * 0.55;
    for (const pd of World.puddles) if (inView(pd.x, pd.y, 20)) {
      ctx.fillStyle = 'rgba(120,150,190,.55)'; ctx.beginPath(); ctx.ellipse(pd.x, pd.y, pd.rx, pd.ry, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(220,235,255,.35)'; ctx.fillRect(pd.x - pd.rx * 0.4, pd.y - 1, pd.rx * 0.5, 1.5);
    }
    ctx.globalAlpha = 1;
  }
  // Marcas de explosiones
  for (const sc of G.scorch) if (inView(sc.x, sc.y, 60)) { ctx.globalAlpha = Math.min(0.55, sc.t / 40); ctx.fillStyle = '#111'; circ(ctx, sc.x, sc.y, sc.r); }
  ctx.globalAlpha = 1;
  // Huellas de derrape
  for (const s of G.skids) if (inView(s.x, s.y)) {
    ctx.globalAlpha = Math.min(0.45, s.t / 7 * 0.45); ctx.fillStyle = '#111';
    ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.a); ctx.fillRect(-3, -1.2, 6, 2.4); ctx.restore();
  }
  ctx.globalAlpha = 1;
  // Vía cerrada
  if (G.events.closed) for (const i of G.events.closed.tiles) {
    const x = (i % MW) * T, y = Math.floor(i / MW) * T;
    for (let k = 0; k < 4; k++) { ctx.fillStyle = k % 2 ? '#fafafa' : '#ff6d00'; ctx.fillRect(x + k * 8, y + 10, 8, 12); }
    ctx.fillStyle = '#212121'; ctx.fillRect(x + 2, y + 22, 3, 6); ctx.fillRect(x + 27, y + 22, 3, 6);
  }
  // Retén: conos
  if (G.events.checkpoint) {
    const c = G.events.checkpoint;
    for (let k = -2; k <= 2; k++) {
      const x = c.h ? c.x + k * 22 : c.x, y = c.h ? c.y : c.y + k * 22;
      ctx.fillStyle = '#ff6d00'; circ(ctx, x, y, 4); ctx.fillStyle = '#fff'; circ(ctx, x, y, 1.6);
    }
  }
  // Festival: tarima
  if (G.events.festival) {
    const f = G.events.festival;
    ctx.fillStyle = '#212121'; ctx.fillRect(f.x - 40, f.y - 70, 80, 26);
    ctx.fillStyle = `hsl(${(time * 120) % 360},90%,60%)`; ctx.fillRect(f.x - 36, f.y - 66, 72, 4);
  }
  // Palomas de la Plaza de Bolívar
  for (const pg of World.pigeons) if (inView(pg.x, pg.y)) {
    ctx.fillStyle = '#8e8e96'; ctx.beginPath(); ctx.ellipse(pg.x + Math.sin(time * 2 + pg.t) * 2, pg.y, 3, 2, pg.t, 0, TAU); ctx.fill();
  }
  // Aviones parqueados
  for (const pl of World.planes) if (inView(pl.x, pl.y, 80)) drawPlane(ctx, pl.x, pl.y, pl.a, 1, false);
  // Anillo del objetivo
  const tg = currentTarget();
  if (tg && inView(tg.x, tg.y, 60)) {
    const r = 22 + Math.sin(time * 5) * 4;
    ctx.strokeStyle = tg.color; ctx.lineWidth = 3; ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.arc(tg.x, tg.y, r, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 0.18; ctx.fillStyle = tg.color; ctx.beginPath(); ctx.arc(tg.x, tg.y, r, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }
  // Plata tirada
  for (const k of G.pickups) if (inView(k.x, k.y)) {
    const b = Math.sin(time * 5) * 2;
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(k.x, k.y + 5, 7, 3, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#43a047'; ctx.fillRect(k.x - 7, k.y - 4 + b, 14, 8); ctx.fillStyle = '#a5d6a7'; ctx.fillRect(k.x - 2, k.y - 2 + b, 4, 4);
  }
  // NPCs que dan misiones
  for (const q of World.pois) if (q.type === 'giver' && inView(q.x, q.y)) drawPerson(ctx, q.x, q.y, sideAngle(q.side), giverLook(q), 0);
  // Peatones
  const umb = G.rain > 0.25;
  for (const pd of G.peds) if (inView(pd.x, pd.y)) drawPerson(ctx, pd.x, pd.y, pd.angle, pd.look, pd.anim, { alpha: pd.alpha, down: pd.mode === 'down', umbrella: umb && pd.umbrella && pd.mode !== 'down' ? pd.umbrella : null, gun: pd.gang ? pd.w : pd.officer && G.wanted >= 2 ? 'pistola' : null });
  // Vehículos
  for (const v of G.vehicles) if (inView(v.x, v.y, 60)) drawVehicle(ctx, v, time);
  // Jugador
  const p = G.player;
  if (G.state === 'play' && p.onFoot && !p.hidden) {
    if (p.hurtT > 0) ctx.globalAlpha = 0.5 + Math.sin(time * 40) * 0.5;
    drawPerson(ctx, p.x, p.y, p.angle, playerLook(), p.moving ? p.anim : 0, { box: G.mission && G.mission.type === 'delivery' && G.mission.data.picked, gun: G.weapon, punch: p.punchT > 0 });
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(255,213,79,.55)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, TAU); ctx.stroke();
  }
  // Balas (trazadoras) y papas bomba
  ctx.lineWidth = 2;
  for (const b of G.bullets) if (inView(b.x, b.y)) {
    ctx.strokeStyle = b.owner === 'player' ? 'rgba(255,236,150,.95)' : 'rgba(255,120,90,.95)';
    ctx.beginPath(); ctx.moveTo(b.px, b.py); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  for (const gr of G.grenades) { ctx.fillStyle = '#6d4c41'; circ(ctx, gr.x, gr.y, 4); ctx.fillStyle = (time * 10) % 2 < 1 ? '#ff1744' : '#ffd740'; circ(ctx, gr.x + 2, gr.y - 3, 1.6); }
  // Techos y árboles (encima de todo lo del piso)
  for (const b of World.buildings) if (b.x < X1 && b.x + b.w > X0 && b.y - b.lift < Y1 && b.y + b.h > Y0) drawRoof(ctx, b, time);
  for (const st of World.stalls) if (inView(st.x, st.y, 30)) drawStall(ctx, st);
  for (const t of World.trees) if (inView(t.x, t.y, 24)) drawTreeCanopy(ctx, t);
  for (const q of World.pois) if (inView(q.x, q.y, 40)) { if (q.type === 'station') drawStation(ctx, q); else drawAwning(ctx, q); }
  if (G.state === 'play' && p.hidden) { ctx.font = '22px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.globalAlpha = 0.8; ctx.fillText('🌿', p.x, p.y + Math.sin(time * 3)); ctx.globalAlpha = 1; }
  // Avión despegando cada cierto tiempo
  planeT = (planeT + dt) % 45;
  if (planeT < 16) {
    const k = planeT / 16, y = lerp(88 * T, 20 * T, k * k), alt = Math.max(0, (k - 0.45) * 2.2);
    if (inView(9.5 * T, y, 200)) drawPlane(ctx, 9.5 * T, y, -Math.PI / 2, 1 + alt * 0.6, alt);
  }
  // Partículas
  for (const f of G.fx) if (inView(f.x, f.y)) {
    const a = f.t / f.max;
    if (f.type === 'smoke') { ctx.fillStyle = `rgba(90,90,95,${a * 0.5})`; circ(ctx, f.x, f.y, 4 + (1 - a) * 10); }
    else if (f.type === 'spark') { ctx.fillStyle = `rgba(255,214,90,${a})`; ctx.fillRect(f.x, f.y, 2, 2); }
    else if (f.type === 'fire') { ctx.fillStyle = `rgba(255,${120 + (1 - a) * 100 | 0},40,${a})`; circ(ctx, f.x, f.y, 3 + (1 - a) * 7); }
    else if (f.type === 'flash') { ctx.fillStyle = 'rgba(255,240,160,.95)'; circ(ctx, f.x, f.y, 5); }
    else if (f.type === 'hit') { ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.font = '12px sans-serif'; ctx.fillText('💥', f.x, f.y); }
    else if (f.type === 'confetti') { ctx.fillStyle = `hsla(${(f.x * 7) % 360},90%,60%,${a})`; ctx.fillRect(f.x, f.y, 3, 3); }
    else if (f.type === 'note') { ctx.fillStyle = `rgba(255,128,255,${a})`; ctx.font = 'bold 14px sans-serif'; ctx.fillText('♪', f.x, f.y); }
  }
  // Íconos flotantes de lugares
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const q of World.pois) {
    if (!inView(q.x, q.y, 30) || q.type === 'atm' && !(G.mission && G.mission.type === 'rumba')) continue;
    if (q.type === 'hide' && G.wanted === 0) continue;
    const near = dist(q.x, q.y, p.x, p.y) < 160;
    const bob = Math.sin(time * 3 + q.x) * 2.5;
    const locked = q.type === 'giver' && G.rep < MISSION_INFO[q.mission].rep;
    const y = q.y - (q.type === 'giver' ? 34 : 26) + bob;
    const r = q.type === 'giver' ? 13 : 10;
    ctx.fillStyle = 'rgba(0,0,0,.35)'; circ(ctx, q.x + 1, y + 2, r);
    ctx.fillStyle = locked ? '#616161' : q.color; circ(ctx, q.x, y, r);
    ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.font = `${r + 2}px sans-serif`;
    ctx.fillText(locked ? '🔒' : q.icon, q.x, y + 1);
    if (q.type === 'giver' && !locked && !G.mission) { ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif'; ctx.fillText('!', q.x + r, y - r + 2); }
    if (near) {
      ctx.font = '600 11px Barlow Condensed, sans-serif';
      const w = ctx.measureText(q.name).width + 10;
      ctx.fillStyle = 'rgba(10,14,22,.78)'; ctx.fillRect(q.x - w / 2, y - r - 18, w, 14);
      ctx.fillStyle = '#fff'; ctx.fillText(q.name, q.x, y - r - 11);
    }
  }
  // Íconos sobre peatones especiales
  for (const pd of G.peds) if (pd.icon && inView(pd.x, pd.y) && pd.mode !== 'gone') { ctx.font = '14px sans-serif'; ctx.fillText(pd.icon, pd.x, pd.y - 20 + Math.sin(time * 4) * 2); }
  // Flecha del objetivo
  if (tg && inView(tg.x, tg.y, 60)) {
    const y = tg.y - 44 + Math.sin(time * 5) * 5;
    ctx.fillStyle = tg.color; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(tg.x - 10, y - 12); ctx.lineTo(tg.x + 10, y - 12); ctx.lineTo(tg.x, y + 2); ctx.closePath(); ctx.stroke(); ctx.fill();
  }
  // Textos flotantes y globos
  for (const f of G.floaters) {
    const a = Math.min(1, f.t);
    ctx.globalAlpha = a; ctx.font = '800 16px Barlow Condensed, sans-serif';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(f.text, f.x, f.y - (1.5 - f.t) * 26);
    ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y - (1.5 - f.t) * 26);
  }
  ctx.globalAlpha = 1;
  for (const b of G.bubbles) {
    const e = b.ent; if (!inView(e.x, e.y)) continue;
    ctx.globalAlpha = Math.min(1, b.t * 2);
    ctx.font = '600 12px Barlow Condensed, sans-serif';
    const w = ctx.measureText(b.text).width + 12, x = e.x, y = e.y - 34;
    ctx.fillStyle = 'rgba(255,255,255,.95)'; rr(ctx, x - w / 2, y - 10, w, 18, 6);
    ctx.beginPath(); ctx.moveTo(x - 4, y + 8); ctx.lineTo(x + 4, y + 8); ctx.lineTo(x, y + 13); ctx.fill();
    ctx.fillStyle = '#1a1a1a'; ctx.fillText(b.text, x, y);
  }
  ctx.globalAlpha = 1;
  // Mira del arma cuando se apunta con el mouse
  if (G.state === 'play' && p.onFoot && G.mouse && !isTouch() && performance.now() - G.mouse.t < 5000 && !WEAPONS[G.weapon].melee) {
    const mx = cam.x + (G.mouse.sx - VW / 2) / cam.zoom, my = cam.y + (G.mouse.sy - VH / 2) / cam.zoom;
    ctx.strokeStyle = 'rgba(255,82,82,.9)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(mx, my, 8, 0, TAU); ctx.moveTo(mx - 12, my); ctx.lineTo(mx - 4, my); ctx.moveTo(mx + 4, my); ctx.lineTo(mx + 12, my);
    ctx.moveTo(mx, my - 12); ctx.lineTo(mx, my - 4); ctx.moveTo(mx, my + 4); ctx.lineTo(mx, my + 12); ctx.stroke();
  }
  renderLighting(time, inView, X0, X1, Y0, Y1);
  if (G.flash > 0) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = `rgba(255,230,180,${G.flash * 0.6})`; ctx.fillRect(0, 0, cv.width, cv.height); }
  renderRain(dt);
  // Atardecer
  const h = G.minutes / 60;
  if ((h > 16.5 && h < 19.5) || (h > 5 && h < 7)) {
    const k = h > 12 ? 1 - Math.abs(h - 18) / 1.5 : 1 - Math.abs(h - 6) / 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = `rgba(255,120,50,${clamp(k, 0, 1) * 0.12})`; ctx.fillRect(0, 0, cv.width, cv.height);
  }
  if (G.lightning > 0) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = `rgba(230,240,255,${G.lightning * 0.55})`; ctx.fillRect(0, 0, cv.width, cv.height); }
  // Indicador de objetivo fuera de pantalla
  if (G.state === 'play' && tg && !onScreen(tg.x, tg.y, -30)) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const sx = VW / 2 + (tg.x - cam.x) * cam.zoom, sy = VH / 2 + (tg.y - cam.y) * cam.zoom;
    const ang = Math.atan2(sy - VH / 2, sx - VW / 2);
    const mx = VW / 2 - 50, my = VH / 2 - 50;
    const k = Math.min(mx / Math.abs(Math.cos(ang) || 1e-6), my / Math.abs(Math.sin(ang) || 1e-6));
    const ex = VW / 2 + Math.cos(ang) * k, ey = VH / 2 + Math.sin(ang) * k;
    ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang);
    ctx.fillStyle = tg.color; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(-8, -11); ctx.lineTo(-3, 0); ctx.lineTo(-8, 11); ctx.closePath(); ctx.stroke(); ctx.fill();
    ctx.restore();
    const m = Math.round(dist(p.x, p.y, tg.x, tg.y) / T * 3);
    ctx.font = '700 13px Barlow Condensed, sans-serif'; ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)';
    const label = m > 999 ? (m / 1000).toFixed(1) + ' km' : m + ' m';
    ctx.strokeText(label, ex - Math.cos(ang) * 26, ey - Math.sin(ang) * 26 + 4); ctx.fillStyle = '#fff'; ctx.fillText(label, ex - Math.cos(ang) * 26, ey - Math.sin(ang) * 26 + 4);
  }
}

function sideAngle(side) { return { N: -Math.PI / 2, S: Math.PI / 2, W: Math.PI, E: 0 }[side] || 0; }
const GIVER_LOOKS = {};
function giverLook(q) {
  if (!GIVER_LOOKS[q.id]) {
    const r = mulberry32(q.id.length * 977 + q.id.charCodeAt(2));
    GIVER_LOOKS[q.id] = { skin: pickR(r, SKINS), hair: pickR(r, HAIRS), shirt: q.color, pants: pickR(r, PANTS), ruana: q.mission === 'volada' };
  }
  return GIVER_LOOKS[q.id];
}

function drawPlane(g, x, y, a, s, alt) {
  g.save();
  if (alt) { g.fillStyle = 'rgba(0,0,0,.2)'; g.save(); g.translate(x + alt * 60, y + alt * 50); g.rotate(a); g.scale(s, s); g.fillRect(-30, -4, 60, 8); g.fillRect(-6, -30, 12, 60); g.restore(); }
  g.translate(x, y); g.rotate(a); g.scale(s, s);
  g.fillStyle = '#eceff1'; rr(g, -34, -5, 68, 10, 5);
  g.fillStyle = '#cfd8dc'; g.beginPath(); g.moveTo(4, -5); g.lineTo(-10, -34); g.lineTo(-18, -34); g.lineTo(-8, -5); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(4, 5); g.lineTo(-10, 34); g.lineTo(-18, 34); g.lineTo(-8, 5); g.closePath(); g.fill();
  g.fillRect(-34, -12, 8, 24);
  g.fillStyle = '#c8102e'; g.fillRect(-34, -2, 10, 4);
  g.fillStyle = '#263238'; g.fillRect(26, -3, 5, 6);
  g.restore();
}

/** Capa de oscuridad nocturna con luces "recortadas". */
function renderLighting(time, inView, X0, X1, Y0, Y1) {
  const dk = darkness();
  if (dk < 0.03) return;
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.globalCompositeOperation = 'source-over'; lctx.globalAlpha = 1;
  lctx.fillStyle = `rgba(6,10,34,${Math.min(0.74, dk)})`; lctx.fillRect(0, 0, lc.width, lc.height);
  lctx.globalCompositeOperation = 'destination-out';
  worldTransform(lctx);
  lctx.globalAlpha = 0.9;
  for (const l of World.lamps) if (inView(l.x, l.y, 80)) lctx.drawImage(LIGHT, l.x - 95, l.y - 95, 190, 190);
  lctx.globalAlpha = 0.7;
  for (const q of World.pois) if (inView(q.x, q.y, 60) && q.type !== 'hide') lctx.drawImage(LIGHT, q.x - 45, q.y - 45, 90, 90);
  for (const b of World.buildings) if (b.kind === 'glass' && b.x < X1 && b.x + b.w > X0 && b.y < Y1 && b.y + b.h > Y0) { lctx.globalAlpha = 0.35; lctx.drawImage(LIGHT, b.x - 10, b.y - b.lift - 10, b.w + 20, b.h + 20); }
  lctx.globalAlpha = 1;
  for (const v of G.vehicles) {
    if (!inView(v.x, v.y, 160) || v.wrecked || (!v.driver && !v.owned)) continue;
    if (!v.driver) continue;
    const c = Math.cos(v.angle), s = Math.sin(v.angle), fl = v.spec.len / 2;
    lctx.save(); lctx.translate(v.x + c * fl, v.y + s * fl); lctx.rotate(v.angle);
    const L = v.spec.two ? 110 : 160;
    lctx.drawImage(CONE, 0, -L * 0.3, L, L * 0.6); lctx.restore();
    lctx.drawImage(LIGHT, v.x - 26, v.y - 26, 52, 52);
  }
  const p = G.player;
  if (G.state === 'play') lctx.drawImage(LIGHT, p.x - 55, p.y - 55, 110, 110);
  if (G.events.festival && inView(G.events.festival.x, G.events.festival.y, 200)) lctx.drawImage(LIGHT, G.events.festival.x - 160, G.events.festival.y - 160, 320, 320);
  lctx.globalCompositeOperation = 'source-over';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(lc, 0, 0);
  // Brillos de color (luz cálida, neón y sirenas)
  worldTransform(ctx);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.22 * dk;
  for (const l of World.lamps) if (inView(l.x, l.y, 50)) ctx.drawImage(GLOW, l.x - 40, l.y - 40, 80, 80);
  ctx.globalAlpha = 0.75 * dk; ctx.lineWidth = 3;
  for (const b of World.buildings) if (b.kind === 'glass' && b.x < X1 && b.x + b.w > X0 && b.y < Y1 && b.y + b.h > Y0) { ctx.strokeStyle = b.neon; ctx.strokeRect(b.x + 3, b.y - b.lift + 3, b.w - 6, b.h - 6); }
  for (const b of World.buildings) if (b.kind === 'tower' && inView(b.x, b.y)) { ctx.fillStyle = (time % 1.4) < 0.7 ? '#ff1744' : '#300'; circ(ctx, b.x + b.w / 2, b.y - b.lift + b.h / 2, 10); }
  for (const v of G.vehicles) if (v.siren && inView(v.x, v.y, 80)) {
    ctx.globalAlpha = 0.5 * Math.max(0.4, dk);
    ctx.drawImage((time * 6) % 2 < 1 ? SIREN_R : SIREN_B, v.x - 50, v.y - 50, 100, 100);
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
}
const SIREN_R = makeSprite(64, [[0, 'rgba(255,30,60,1)'], [1, 'rgba(255,30,60,0)']]);
const SIREN_B = makeSprite(64, [[0, 'rgba(40,110,255,1)'], [1, 'rgba(40,110,255,0)']]);

function updateFx(dt) {
  for (const f of G.fx) { f.t -= dt; f.x += f.vx * dt; f.y += f.vy * dt; f.vx *= 0.96; f.vy *= 0.96; }
  G.fx = G.fx.filter(f => f.t > 0);
  for (const f of G.floaters) f.t -= dt;
  G.floaters = G.floaters.filter(f => f.t > 0);
  for (const b of G.bubbles) b.t -= dt;
  G.bubbles = G.bubbles.filter(b => b.t > 0 && (b.ent === G.player || b.ent.alpha == null || b.ent.alpha > 0));
  for (const s of G.skids) s.t -= dt;
  G.skids = G.skids.filter(s => s.t > 0);
  // Palomas que vuelan si pasas cerca
  const p = G.player;
  for (const pg of World.pigeons) {
    if (pg.fly > 0) { pg.fly -= dt; pg.x += pg.vx * dt; pg.y += pg.vy * dt; }
    else if (G.state === 'play' && dist(pg.x, pg.y, p.x, p.y) < 40) { pg.fly = 0.8; const a = Math.atan2(pg.y - p.y, pg.x - p.x) + rand(-0.5, 0.5); pg.vx = Math.cos(a) * 120; pg.vy = Math.sin(a) * 120; }
  }
}

function updateCamera(dt) {
  const p = G.player;
  let tx = p.x, ty = p.y, z = cam.base;
  if (!p.onFoot && p.vehicle) {
    const v = p.vehicle;
    tx += v.vx * 0.42; ty += v.vy * 0.42;
    z = cam.base * (1 - Math.min(1, Math.abs(v.speed) / 420) * 0.24);
  }
  const k = 1 - Math.exp(-dt * 5);
  cam.x = lerp(cam.x, tx, k); cam.y = lerp(cam.y, ty, k);
  cam.zoom = lerp(cam.zoom, z, 1 - Math.exp(-dt * 1.8));
  cam.shake = Math.max(0, cam.shake - dt * 25);
}

// ==========================================================================
// 14. COMBATE: armas, balas, papas bomba y explosiones
// ==========================================================================
function ownedWeapons() { return WEAPON_ORDER.filter(w => w === 'punos' || (w === 'papa' ? G.ammo.papa > 0 : G.weapons[w])); }
function cycleWeapon() {
  const list = ownedWeapons();
  const i = list.indexOf(G.weapon);
  G.weapon = list[(i + 1) % list.length];
  const w = WEAPONS[G.weapon];
  toast(`${w.icon} ${w.n}${w.melee ? '' : ' · ' + (G.ammo[G.weapon] || 0) + ' tiros'}`);
  Sound.sfx('click');
}

/** Ángulo de disparo: el mouse si lo estás usando; si no, autoapuntado al enemigo más cercano. */
function aimAngle() {
  const p = G.player;
  if (G.mouse && performance.now() - G.mouse.t < 5000 && !isTouch()) {
    const wx = cam.x + (G.mouse.sx - VW / 2) / cam.zoom, wy = cam.y + (G.mouse.sy - VH / 2) / cam.zoom;
    return Math.atan2(wy - p.y, wx - p.x);
  }
  const w = WEAPONS[G.weapon], range = w.melee ? 60 : Math.min(w.range || 300, 360);
  let best = null, bd = 1e9;
  for (const o of G.peds) {
    const hostile = o.mode === 'gang' || o.mode === 'thief' || (o.mode === 'cop' && G.wanted > 0);
    if (!hostile) continue;
    const d = dist(p.x, p.y, o.x, o.y);
    if (d > range) continue;
    const a = Math.atan2(o.y - p.y, o.x - p.x);
    if (!isTouch() && Math.abs(angDiff(p.angle, a)) > 1.2) continue;
    if (d < bd && losClear(p.x, p.y, o.x, o.y)) { bd = d; best = a; }
  }
  return best != null ? best : p.angle;
}

function fireBullet(x, y, a, owner, dmg, speed = 900, range = 500) {
  G.bullets.push({ x, y, px: x, py: y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, owner, dmg, life: range / speed });
}

function playerAttack() {
  const p = G.player, w = WEAPONS[G.weapon];
  if (!w.melee && !(G.ammo[G.weapon] > 0)) {
    toast('🔫 Sin munición: cómprala donde Los Fierros del Mono'); Sound.sfx('deny'); G.fireCD = 0.6;
    G.weapon = 'punos'; return;
  }
  const a = aimAngle();
  p.angle = a; G.fireCD = w.rate; p.punchT = 0.18;
  const c = Math.cos(a), s = Math.sin(a);
  if (w.melee) {
    Sound.sfx('punch');
    let hit = false;
    for (const o of G.peds) {
      if (o.mode === 'gone' || o.mode === 'down') continue;
      const d = dist(p.x, p.y, o.x, o.y);
      if (d < w.range + 8 && Math.abs(angDiff(a, Math.atan2(o.y - p.y, o.x - p.x))) < 1.1) {
        damagePed(o, w.dmg, 'player');
        const l = d || 1; moveCircle(o, (o.x - p.x) / l * 10, (o.y - p.y) / l * 10, 5);
        hit = true; break;
      }
    }
    if (!hit) for (const v of G.vehicles) {
      if (dist(p.x + c * 16, p.y + s * 16, v.x, v.y) < v.spec.len / 2 + 6) {
        v.hp = Math.max(0, v.hp - (G.weapon === 'bate' ? 6 : 1)); Sound.sfx('bump');
        addFx('spark', p.x + c * 14, p.y + s * 14, rand(-40, 40), rand(-40, 40), 0.3);
        if (v.mode === 'traffic' && Math.random() < 0.5) bubble(v, '¡Ey, mi carro! ¿Está loco?');
        break;
      }
    }
    return;
  }
  G.ammo[G.weapon]--;
  if (w.thrown) {
    G.grenades.push({ x: p.x + c * 10, y: p.y + s * 10, vx: c * 320, vy: s * 320, t: 0.85, owner: 'player' });
    Sound.sfx('door');
    if (!(G.ammo.papa > 0)) G.weapon = 'punos';
  } else {
    for (let k = 0; k < (w.pellets || 1); k++) fireBullet(p.x + c * 11, p.y + s * 11, a + rand(-w.spread, w.spread), 'player', w.dmg, w.speed, w.range);
    addFx('flash', p.x + c * 14, p.y + s * 14, 0, 0, 0.06);
    Sound.sfx(G.weapon === 'escopeta' ? 'shotgun' : G.weapon === 'uzi' ? 'uzi' : 'shot');
  }
  // Los disparos asustan y alguien llama a la policía
  for (const o of G.peds) if (o.mode === 'walk' && dist(o.x, o.y, p.x, p.y) < 380) scarePed(o, p.x, p.y, 3);
  const inGangFight = G.mission && G.mission.type === 'pandilla' && G.mission.idx > 0;
  G.snitchCD -= 1;
  if (G.wanted === 0 && !inGangFight) {
    if (copWitness(p.x, p.y)) addWanted(1, 'Disparos en la vía pública');
    else if (G.snitchCD <= 0 && Math.random() < 0.25) { G.snitchCD = 8; addWanted(1, pick(SNITCH_LINES)); }
  }
}

function pedHp(p) { return p.officer ? 60 : p.gang ? 55 : 30; }
function damagePed(p, dmg, src) {
  if (p.mode === 'gone' || p.mode === 'down') return;
  if (p.keep && !p.gang) return; // turistas, pasajeros, etc.
  if (p.hp == null) p.hp = pedHp(p);
  p.hp -= dmg;
  addFx('hit', p.x, p.y - 4, rand(-20, 20), -30, 0.4);
  if (p.hp <= 0) { knockOut(p, src); return; }
  if (p.mode === 'walk' || p.mode === 'static' || p.mode === 'dance') scarePed(p, G.player.x, G.player.y, 3);
  if (src === 'player' && p.officer && G.wanted < 2) addWanted(1, 'Le pegaste a un policía');
}
function knockOut(p, src) {
  const wasCop = p.officer, wasGang = p.gang;
  p.mode = 'down'; p.downT = wasGang || wasCop ? 7 : 6; p.ko = true; p.koGone = wasGang || wasCop; p.keep = false;
  floater(p.x, p.y - 18, '💫 ¡Noqueado!', '#ffd54f');
  if (src !== 'player') return;
  if (wasCop) addWanted(1, 'Noqueaste a un policía');
  else if (!wasGang && G.wanted === 0 && (copWitness(p.x, p.y) || Math.random() < 0.5)) addWanted(1, pick(SNITCH_LINES));
}

function updateBullets(dt) {
  const p = G.player;
  for (const b of G.bullets) {
    b.px = b.x; b.py = b.y;
    const subs = Math.max(2, Math.ceil(Math.hypot(b.vx, b.vy) * dt / 6));
    for (let sub = 0; sub < subs && b.life > 0; sub++) {
      b.x += b.vx * dt / subs; b.y += b.vy * dt / subs;
      if (solidAt(b.x, b.y)) { addFx('spark', b.x, b.y, rand(-50, 50), rand(-50, 50), 0.25); b.life = 0; break; }
      // Vehículos
      for (const v of G.vehicles) {
        if (Math.abs(v.x - b.x) > 50 || Math.abs(v.y - b.y) > 50) continue;
        if (b.owner === 'player' && v === p.vehicle) continue;
        if (b.owner === 'cop' && v.driver === 'cop') continue;
        if (vehCircles(v).some(c => dist(c[0], c[1], b.x, b.y) < c[2])) {
          damageVehicle(v, b.dmg * 0.6, b.owner);
          if (v === p.vehicle && b.owner !== 'player') damagePlayer(b.dmg * 0.25);
          addFx('spark', b.x, b.y, rand(-40, 40), rand(-40, 40), 0.25);
          b.life = 0; break;
        }
      }
      if (b.life <= 0) break;
      // Personas
      for (const o of G.peds) {
        if (o.mode === 'gone' || o.mode === 'down') continue;
        if (b.owner === 'gang' && o.gang) continue;
        if (b.owner === 'cop' && o.officer) continue;
        if (Math.abs(o.x - b.x) < 7 && Math.abs(o.y - b.y) < 7) { damagePed(o, b.dmg, b.owner); b.life = 0; break; }
      }
      if (b.life <= 0) break;
      if (b.owner !== 'player' && p.onFoot && !p.hidden && Math.abs(p.x - b.x) < 8 && Math.abs(p.y - b.y) < 8) {
        damagePlayer(b.dmg); shake(4); b.life = 0;
      }
    }
    b.life -= dt;
  }
  G.bullets = G.bullets.filter(b => b.life > 0);
  // Papas bomba
  for (const g of G.grenades) {
    g.t -= dt;
    const nx = g.x + g.vx * dt, ny = g.y + g.vy * dt;
    if (solidAt(nx, ny)) { g.vx *= -0.4; g.vy *= -0.4; } else { g.x = nx; g.y = ny; }
    g.vx *= 0.97; g.vy *= 0.97;
    if (Math.random() < 0.5) addFx('smoke', g.x, g.y, 0, -10, 0.4);
    // Explota al pegarle a un carro o a una persona
    if (G.vehicles.some(v => v !== G.player.vehicle && vehCircles(v).some(c => dist(c[0], c[1], g.x, g.y) < c[2] + 3)) ||
        G.peds.some(o => o.mode !== 'gone' && o.mode !== 'down' && dist(o.x, o.y, g.x, g.y) < 9)) g.t = 0;
    if (g.t <= 0) explode(g.x, g.y, WEAPONS.papa.radius, WEAPONS.papa.dmg, g.owner);
  }
  G.grenades = G.grenades.filter(g => g.t > 0);
}

function damageVehicle(v, dmg, owner) {
  v.hp -= dmg;
  if (v.mode === 'traffic' && v.driver === 'npc') { v.stopT = 2; if (Math.random() < 0.3) bubble(v, '¡Me están disparando! 😱'); }
  if (v.hp <= 0 && !v.burnt && !(v.burnT > 0)) {
    v.hp = 0; v.burnT = 2.6; v.wrecked = true; v.siren = false;
    if (v.mode === 'traffic') { const vv = vehVel(v); v.vx = vv[0] * 0.3; v.vy = vv[1] * 0.3; v.mode = 'physics'; }
    if (v.driver === 'npc' || v.driver === 'cop' || v.driver === 'racer') {
      const fl = new Ped({ x: v.x + Math.cos(v.angle - 1.57) * 18, y: v.y + Math.sin(v.angle - 1.57) * 18, mode: 'flee', look: v.rider });
      fl.fleeT = 4; fl.fx = v.x; fl.fy = v.y; fl.speed = 120; fl.umbrella = null;
      if (circleFree(fl.x, fl.y, 5)) G.peds.push(fl);
      v.driver = null;
    }
    if (v === G.player.vehicle) toast('🔥 ¡Bájate (F) que eso explota!');
  }
  if (owner === 'player' && v.type === 'police' && G.wanted < 2) addWanted(1, 'Atacaste una patrulla');
}

function updateBurning(v, dt) {
  if (!(v.burnT > 0)) return;
  if (v === G.player.vehicle && dt === 0) return;
  v.burnT -= dt;
  if (Math.random() < 0.8) addFx('fire', v.x + rand(-8, 8), v.y + rand(-6, 6), rand(-10, 10), rand(-30, -10), rand(0.3, 0.6));
  if (v.burnT <= 0) {
    v.burnt = true; v.burnT = 0;
    if (v === G.player.vehicle) { exitVehicle(); damagePlayer(35); }
    explode(v.x, v.y, 85, 55, 'vehicle');
  }
}

function explode(x, y, radius, dmg, owner) {
  Sound.sfx('boom'); shake(16);
  G.flash = 0.5;
  for (let k = 0; k < 26; k++) { const a = rand(0, TAU), sp = rand(30, 160); addFx('fire', x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.3, 0.8)); }
  for (let k = 0; k < 14; k++) addFx('smoke', x + rand(-20, 20), y + rand(-20, 20), rand(-20, 20), rand(-40, -10), rand(1.2, 2.4));
  G.scorch.push({ x, y, r: radius * 0.5, t: 40 });
  for (const o of G.peds) {
    const d = dist(o.x, o.y, x, y);
    if (d < radius) { damagePed(o, dmg * (1 - d / radius) + 12, owner); if (o.mode !== 'gone') moveCircle(o, (o.x - x) / (d || 1) * 20, (o.y - y) / (d || 1) * 20, 5); }
  }
  for (const v of G.vehicles) {
    const d = dist(v.x, v.y, x, y);
    if (d < radius + 10 && !v.burnt) { damageVehicle(v, dmg * (1 - d / (radius + 10)) * 1.3, owner); if (v.mode === 'physics') { v.vx += (v.x - x) / (d || 1) * 120; v.vy += (v.y - y) / (d || 1) * 120; } }
  }
  const p = G.player, d = dist(p.x, p.y, x, y);
  if (d < radius) damagePlayer(dmg * (1 - d / radius) * (p.onFoot ? 0.7 : 0.3));
  if (owner === 'player' && G.wanted < 2 && (copWitness(x, y) || Math.random() < 0.7)) addWanted(G.wanted === 0 ? 2 : 1, '¡Explosión en plena calle!');
}

/** Pandilleros: se acercan, disparan o pegan con bate. */
function updateGang(p, dt) {
  const pl = G.player;
  const tx = pl.x, ty = pl.y, d = dist(p.x, p.y, tx, ty);
  p.cool = (p.cool || rand(0.5, 1.5)) - dt;
  const sees = d < 430 && !pl.hidden && losClear(p.x, p.y, tx, ty);
  p.anim += dt * 10;
  if (!sees) { if (Math.random() < dt) p.angle += rand(-1, 1); return; }
  p.angle = Math.atan2(ty - p.y, tx - p.x);
  const c = Math.cos(p.angle), s = Math.sin(p.angle);
  if (p.w === 'bate') {
    if (d > 20) moveCircle(p, c * 118 * dt, s * 118 * dt, 5);
    else if (p.cool <= 0) { p.cool = 0.9; if (pl.onFoot) { damagePlayer(11); shake(5); Sound.sfx('punch'); } else damageVehicle(pl.vehicle, 4, 'gang'); }
  } else {
    const want = 160, strafe = Math.sin(p.t * 1.7 + p.seed) * 60;
    const k = d > want ? 1 : d < 90 ? -1 : 0;
    moveCircle(p, (c * k * 95 - s * strafe * 0.6) * dt, (s * k * 95 + c * strafe * 0.6) * dt, 5);
    if (p.cool <= 0) { p.cool = rand(0.8, 1.4); fireBullet(p.x + c * 9, p.y + s * 9, p.angle + rand(-0.15, 0.15), 'gang', 7, 700, 460); addFx('flash', p.x + c * 11, p.y + s * 11, 0, 0, 0.06); Sound.sfx('shot'); }
  }
  if (Math.random() < dt * 0.15) bubble(p, pick(['¡Esta es mi cuadra!', '¡Quieto, sapo!', '¡Se metió con quien no era!', '¡Fuera de aquí, ñero!']));
}

/** Policías a pie disparan cuando la búsqueda es de 2 estrellas o más. */
function copShoot(o, dt) {
  const pl = G.player;
  if (G.wanted < 2 || pl.hidden) return;
  o.cool = (o.cool == null ? 1 : o.cool) - dt;
  const d = dist(o.x, o.y, pl.x, pl.y);
  if (o.cool <= 0 && d < 300 && d > 30 && losClear(o.x, o.y, pl.x, pl.y)) {
    o.cool = G.wanted >= 3 ? 0.8 : 1.3;
    const a = Math.atan2(pl.y - o.y, pl.x - o.x);
    fireBullet(o.x + Math.cos(a) * 9, o.y + Math.sin(a) * 9, a + rand(-0.12, 0.12), 'cop', 6, 800, 420);
    addFx('flash', o.x + Math.cos(a) * 11, o.y + Math.sin(a) * 11, 0, 0, 0.06); Sound.sfx('shot');
  }
}
/** Con 3 estrellas disparan desde las patrullas. */
function copCarShoot(v, dt) {
  const pl = G.player;
  if (G.wanted < 3 || !v.chase || v.wrecked || pl.hidden) return;
  v.shootT = (v.shootT == null ? 1.5 : v.shootT) - dt;
  const tx = pl.onFoot ? pl.x : pl.vehicle.x, ty = pl.onFoot ? pl.y : pl.vehicle.y;
  const d = dist(v.x, v.y, tx, ty);
  if (v.shootT <= 0 && d < 330 && losClear(v.x, v.y, tx, ty)) {
    v.shootT = 1.3;
    const a = Math.atan2(ty - v.y, tx - v.x);
    fireBullet(v.x + Math.cos(a) * 20, v.y + Math.sin(a) * 20, a + rand(-0.1, 0.1), 'cop', 6, 800, 420);
    Sound.sfx('shot');
  }
}

// ==========================================================================
// 15. VIAJES ENTRE CIUDADES
// ==========================================================================
function flightPrice(id) { return Math.max(CITIES[id].price, CITY.price) || 300000; }
function menuFlights() {
  return () => ({
    title: 'Aeropuerto ' + CITY.airport, icon: '✈️', color: '#4fc3f7', sub: `Estás en ${CITY.name} · 💵 ${fmtMoney(G.money)}`,
    info: 'Vuela por Colombia: cada ciudad tiene su comida, sus dichos, su emisora y sus propias misiones. Tus vehículos los sacas del garaje en el hotel o en tu casa.',
    items: CITY_ORDER.filter(id => id !== CITY.id).map(id => {
      const c = CITIES[id], price = flightPrice(id);
      return {
        label: `✈️ ${c.name} · <i>${c.nick}</i>`, sub: c.welcome, right: fmtMoney(price),
        disabled: G.mission ? 'Termina primero tu misión' : G.wanted > 0 ? 'Con la tomba encima no te dejan abordar' : G.money < price ? 'No te alcanza 💸' : false,
        action: () => { flyTo(id, price); return 'close'; },
      };
    }).concat([{ label: 'Salir', action: () => 'close' }]),
  });
}
function flyTo(id, price) {
  if (!spend(price)) return;
  fadeTransition(() => { switchCity(id); advanceTime(80); }, `✈️ Volando a ${CITIES[id].name}…`);
}
function switchCity(id, spawn) {
  if (G.outVeh && G.garage[G.outVeh.ownIdx]) G.garage[G.outVeh.ownIdx].hp = G.outVeh.hp;
  resetRun();
  applyCity(id); genWorld(); buildMiniBase();
  G.city = id;
  const sp = spawn || World.airport;
  const p = G.player;
  p.x = sp.x; p.y = sp.y; p.onFoot = true; p.vehicle = null; p.hidden = false;
  cam.x = p.x; cam.y = p.y;
  G.cityVisited[id] = true;
  if (CITY_ORDER.every(c => G.cityVisited[c])) unlock('viajero');
  Sound.radio.station = CITY.radio; Sound.radio.on = true;
  G.weather = 'sol'; G.weatherT = 120; G.rain = 0; G.wetness = 0;
  if (!spawn) {
    banner(`${CITY.name}`, CITY.welcome, '#4fc3f7', true);
    setTimeout(() => notify(`📻 ${STATIONS[CITY.radio].name}`, 'La emisora de la ciudad. Cambia con R.', '#e040fb'), 2500);
  }
  saveGame();
}

function menuHotel(p) {
  const night = HOMES.hotel.night;
  return () => {
    const items = [
      { label: `😴 Dormir hasta las 7:00 a.m.`, sub: 'Recuperas casi toda la energía y +30 de salud', right: fmtMoney(night),
        disabled: G.wanted > 0 ? 'No puedes dormir con la policía encima' : G.mission ? 'Termina primero tu misión' : G.money < night ? 'No te alcanza 💸' : false,
        action: () => { if (spend(night)) goSleep(HOMES.hotel); return 'close'; } },
      { label: '💾 Guardar partida', action: () => { saveGame(); toast('💾 Partida guardada'); } },
      { section: '🚗 Tus vehículos (te los mandan en camión)' },
    ];
    G.garage.forEach((gv, i) => items.push({
      label: VEH[gv.type].name, sub: gv.hp <= 0 ? 'Varado: llévalo al taller' : `Estado ${Math.round(gv.hp / VEH[gv.type].hp * 100)}%`,
      right: G.outVeh && G.outVeh.ownIdx === i ? 'En la calle' : 'Sacar', disabled: gv.hp <= 0 ? 'Está varado' : false,
      action: () => { spawnOwnedVehicle(i, roadSpotNear(p)); toast('🔑 Te dejaron el vehículo en la calle'); return 'close'; },
    }));
    if (!G.garage.length) items.push({ label: 'Todavía no tienes vehículos', disabled: true });
    items.push({ label: 'Salir', action: () => 'close' });
    return { title: p.name, icon: '🏨', color: '#4fc3f7', sub: `${CITY.name} · ${CITY.nick}`, items };
  };
}

// ==========================================================================
// 16. MISIONES NUEVAS
// ==========================================================================
function sidewalkCenterOfPark(key, side = 'S') {
  const [bi, bj] = key.split(',').map(Number);
  const [tx, ty] = sidewalkTile(bi, bj, side, 6);
  return { x: (tx + 0.5) * T, y: (ty + 0.5) * T, name: PARKS[key].name };
}

/** Misión de recorrido por varios puntos. */
function missionRoute(type, points, o) {
  const m = mkMission(type, { timer: o.timer, timerMax: o.timer, data: { n: 0 } });
  m.steps = points.map(pt => ({
    x: pt.x, y: pt.y, r: pt.r || 40, stop: !!o.stop, stopText: o.stopText, text: pt.text,
    check: o.check, checkHint: o.checkHint,
    onReach() { m.data.n++; if (o.payEach) addMoney(o.payEach); if (pt.onReach) pt.onReach(); if (o.reachLine) bubble(G.player, pick(o.reachLine)); Sound.sfx('coin'); },
  }));
  m.extra = o.extra || (() => `${o.icon || '📍'} ${m.data.n}/${points.length}`);
  if (o.update) m.update = dt => o.update(m, dt);
  if (o.cleanup) m.cleanup = () => o.cleanup(m);
  m.onDone = () => { if (o.ach) unlock(o.ach); completeMission(o.pay, o.rep, o.doneText || ''); };
  return m;
}

function missionTaxi(giver) {
  const moto = !CITY.palms ? false : true;
  const m = mkMission('taxi', { timer: 170, timerMax: 170, data: { n: 0 } });
  let prev = { x: giver.x, y: giver.y };
  const peds = [];
  for (let k = 0; k < 3; k++) {
    const a = randomSidewalkPoint((d, x, y) => districtUnlocked(d) && dist(x, y, prev.x, prev.y) > 400 && dist(x, y, prev.x, prev.y) < 1200);
    const b = a && randomSidewalkPoint((d, x, y) => districtUnlocked(d) && dist(x, y, a.x, a.y) > 900 && dist(x, y, a.x, a.y) < 2400);
    if (!a || !b) continue;
    const name = pick(CLIENT_NAMES);
    const fare = round500(9000 + (Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) * 9);
    let ped = null;
    m.steps.push({ x: a.x, y: a.y, r: 46, needSeats: true, stop: true, stopText: 'recoger al pasajero', text: `Recoge a ${name} (${addressOf(a.x, a.y)})`,
      onEnter() { ped = new Ped({ x: a.x, y: a.y, mode: 'static' }); ped.keep = true; ped.umbrella = null; ped.icon = '🙋'; G.peds.push(ped); peds.push(ped); },
      onReach() { if (ped) { ped.keep = false; ped.mode = 'gone'; } bubble(G.player, pick(['¡Uy, gracias, qué rapidez!', 'Lléveme rapidito, porfa', '¿Tiene cargador de celular?', 'Póngame música, pues'])); } });
    m.steps.push({ x: b.x, y: b.y, r: 42, stop: true, stopText: 'dejar al pasajero', text: `Lleva a ${name} a ${addressOf(b.x, b.y)}`,
      onReach() { addMoney(fare); G.rep += 1; m.data.n++; bubble(G.player, pick(CITY.sayings)); } });
    prev = b;
  }
  if (!m.steps.length) return null;
  m.extra = () => `${moto ? '🛵 Mototaxi' : '🚕'} Pasajeros: ${m.data.n}/3`;
  m.cleanup = () => peds.forEach(p => { p.keep = false; p.mode = 'gone'; });
  m.onDone = () => completeMission(40000, 3, '¡Pura vida de taxista!');
  return m;
}

/** Carrera ilegal contra dos pilotos controlados por la máquina. */
function missionCarrera(giver) {
  let cur = nearestNode(giver.x, giver.y), back = -1;
  const nodes = [];
  for (let k = 0; k < 7; k++) {
    for (let hop = 0; hop < 2; hop++) {
      const ex = nodeExits(cur[0], cur[1]).filter(d => d !== back && (() => { const c = nodeCenter(cur[0] + DIRV[d][0], cur[1] + DIRV[d][1]); return canEnter(c[0], c[1]); })());
      if (!ex.length) break;
      const d = pick(ex); back = (d + 2) % 4;
      cur = [cur[0] + DIRV[d][0], cur[1] + DIRV[d][1]];
    }
    nodes.push(cur.slice());
  }
  const pts = nodes.map(n => { const c = nodeCenter(n[0], n[1]); return { x: c[0], y: c[1], node: n }; });
  const fields = nodes.map(n => bfsFrom(n[0], n[1]));
  const m = mkMission('carrera', { data: { racers: [] } });
  m.steps = pts.map((pt, i) => ({ x: pt.x, y: pt.y, r: 64, text: i === pts.length - 1 ? '🏁 ¡Última recta! Llega a la meta' : `Pasa por el punto ${i + 1}/${pts.length}`, check: () => !G.player.onFoot, checkHint: 'Tienes que ir en un vehículo' }));
  m.onStart = () => {
    const spot = roadSpotNear(giver);
    const names = ['El Pecoso', 'La Mona Veloz', 'Brayan Turbo', 'El Chamo'];
    for (let k = 0; k < 2; k++) {
      const v = new Vehicle(k ? 'motosport' : 'sport', spot.x - Math.cos(spot.a) * (50 + k * 40), spot.y - Math.sin(spot.a) * (50 + k * 40), spot.a, { mode: 'physics', driver: 'racer', mission: true, color: k ? '#00e676' : '#ff9100' });
      if (vehicleBlocked(v, v.x, v.y, v.angle)) { v.x = spot.x; v.y = spot.y; }
      v.cp = 0; v.waitT = 3; v.racerName = names[(k + G.day) % names.length];
      G.vehicles.push(v); m.data.racers.push(v);
    }
    floater(G.player.x, G.player.y - 30, '3… 2… 1… ¡PIQUE!', '#ff9100');
  };
  m.update = dt => {
    for (const v of m.data.racers) {
      if (v.wrecked || v.driver !== 'racer') continue;
      if (v.waitT > 0) { v.waitT -= dt; continue; }
      const pt = pts[v.cp];
      const ahead = v.cp > m.idx || (v.cp === m.idx && dist(v.x, v.y, pt.x, pt.y) < dist(G.player.x, G.player.y, pt.x, pt.y));
      aiDrive(v, dt, pt.x, pt.y, fields[v.cp], ahead ? 0.78 : 1);
      if (dist(v.x, v.y, pt.x, pt.y) < 75) {
        v.cp++;
        if (v.cp >= pts.length) { failMission(`${v.racerName} ganó el pique 🏁`); return; }
      }
    }
  };
  m.extra = () => {
    const prog = v => v.cp * 10000 - dist(v.x, v.y, pts[Math.min(v.cp, pts.length - 1)].x, pts[Math.min(v.cp, pts.length - 1)].y);
    const me = m.idx * 10000 - dist(G.player.x, G.player.y, pts[m.idx] ? pts[m.idx].x : 0, pts[m.idx] ? pts[m.idx].y : 0);
    const pos = 1 + m.data.racers.filter(v => !v.wrecked && prog(v) > me).length;
    return `🏁 Vas de ${pos}° de 3`;
  };
  m.cleanup = () => m.data.racers.forEach(v => { v.mission = false; if (v.driver === 'racer') v.driver = null; });
  m.onDone = () => { unlock('piloto'); completeMission(350000, 6, '¡Rey del pique! 🏆'); };
  return m;
}

/** Conducción automática hacia un punto usando el grafo de calles. */
function aiDrive(v, dt, tx, ty, field, maxT = 1) {
  const W = BX + 1;
  let ax = tx, ay = ty;
  if (!(dist(v.x, v.y, tx, ty) < 260 && losClear(v.x, v.y, tx, ty))) {
    if (!v.wpn) v.wpn = nearestNode(v.x, v.y);
    let c = nodeCenter(v.wpn[0], v.wpn[1]);
    if (dist(v.x, v.y, c[0], c[1]) < 70) {
      const cd = field[v.wpn[1] * W + v.wpn[0]];
      let best = null, bd = cd < 0 ? 999 : cd;
      for (const d of nodeExits(v.wpn[0], v.wpn[1])) {
        const ni = v.wpn[0] + DIRV[d][0], nj = v.wpn[1] + DIRV[d][1], val = field[nj * W + ni];
        if (val >= 0 && val < bd) { bd = val; best = [ni, nj]; }
      }
      if (best) { v.wpn = best; c = nodeCenter(best[0], best[1]); }
    }
    ax = c[0]; ay = c[1];
  }
  let diff = angDiff(v.angle, Math.atan2(ay - v.y, ax - v.x));
  const probe = a => solidAt(v.x + Math.cos(a) * 42, v.y + Math.sin(a) * 42);
  if (probe(v.angle)) diff += probe(v.angle - 0.7) ? 1.1 : -1.1;
  let steer = clamp(diff * 2.4, -1, 1), throttle = (Math.abs(diff) > 1.3 && v.speed > 110 ? 0.3 : 1) * maxT;
  if (Math.abs(v.speed) < 15 && throttle > 0.4) v.stuckT += dt; else v.stuckT = Math.max(0, v.stuckT - dt);
  if (v.stuckT > 1.1) { v.reverseT = 0.9; v.stuckT = 0; v.wpn = null; }
  if (v.reverseT > 0) { v.reverseT -= dt; throttle = -1; steer = -steer; }
  updatePhysicsVehicle(v, dt, { throttle, steer, brake: false });
}

function missionPandilla(giver) {
  const parks = Object.keys(PARKS).map(k => { const [bi, bj] = k.split(',').map(Number); return { k, d: DISTRICT_GRID[bj][bi], x: (bi * P + RW + 6.5) * T, y: (bj * P + RW + 6.5) * T }; })
    .filter(o => districtUnlocked(o.d) && !['beach', 'muralla', 'castillo', 'malecon'].includes(PARKS[o.k].kind) && dist(o.x, o.y, giver.x, giver.y) > 500);
  if (!parks.length) return null;
  const pk = parks.sort((a, b) => dist(a.x, a.y, giver.x, giver.y) - dist(b.x, b.y, giver.x, giver.y))[Math.floor(Math.random() * Math.min(3, parks.length))];
  const name = PARKS[pk.k].name;
  const crew = pick(['Los Chirretes', 'La Gallada del Hueco', 'Los Pelados de la Esquina', 'Los Ñeros de la Olla', 'Los Malandros del Barrio']);
  const m = mkMission('pandilla', { timer: 260, timerMax: 260, data: { gang: [] } });
  const n = 6;
  m.steps = [
    { x: pk.x, y: pk.y, r: 230, text: `Ve al ${name}: ${crew} se lo tomaron`, onReach() {
      for (let k = 0; k < n * 4 && m.data.gang.length < n; k++) {
        const a = rand(0, TAU), r = rand(40, 150), x = pk.x + Math.cos(a) * r, y = pk.y + Math.sin(a) * r;
        if (!circleFree(x, y, 6)) continue;
        const g = new Ped({ x, y, mode: 'gang', look: { skin: pick(SKINS), hair: '#111', shirt: pick(['#212121', '#b71c1c', '#311b92']), pants: '#1b1b1b' } });
        g.gang = true; g.keep = true; g.umbrella = null; g.hp = 55; g.w = Math.random() < 0.35 ? 'bate' : 'pistola'; g.seed = Math.random() * 10; g.icon = g.w === 'bate' ? '🏏' : '🔫';
        G.peds.push(g); m.data.gang.push(g);
      }
      notify(`👊 ¡${crew}!`, 'Noquéalos a todos. Q cambia de arma; clic, Ctrl o J para atacar.', '#ff5252');
    } },
    { x: pk.x, y: pk.y, text: `Noquea a ${crew}`, cond: () => m.data.gang.length > 0 && m.data.gang.every(g => g.ko) },
  ];
  m.extra = () => `👊 Noqueados: ${m.data.gang.filter(g => g.ko).length}/${m.data.gang.length || n} · ${WEAPONS[G.weapon].icon}`;
  m.cleanup = () => m.data.gang.forEach(g => { if (!g.ko) { g.keep = false; g.mode = 'gone'; } });
  m.onDone = () => { unlock('barrio'); completeMission(420000, 7, '¡El barrio quedó tranquilo! 🙌'); };
  return m;
}

function missionSilleta(giver) {
  const dest = sidewalkCenterOfPark(Object.keys(PARKS).find(k => PARKS[k].kind === 'botero') || Object.keys(PARKS)[0]);
  const man = Math.abs(dest.x - giver.x) + Math.abs(dest.y - giver.y);
  const m = mkMission('silleta', { timer: Math.round(man / 55 + 30), data: {} });
  m.timerMax = m.timer;
  m.steps = [{ x: dest.x, y: dest.y, r: 50, text: `Lleva la silleta hasta la tarima en ${dest.name} 💐` }];
  m.onStart = () => { G.carry = 'silleta'; bubble(G.player, '¡Uff, qué peso tan berraco!'); };
  m.update = () => {
    if (!G.player.onFoot) failMission('Con la silleta no te podés montar en nada');
    if (Math.random() < 0.006) bubble(G.player, pick(['¡Qué flores tan hermosas!', '¡Avemaría, qué espalda!', '¡Vamos, pues, que ya casi!']));
  };
  m.cleanup = () => { G.carry = null; };
  m.extra = () => '💐 Carga pesada: no puedes correr';
  m.onDone = () => { unlock('silletero'); completeMission(180000, 6, '¡Aplausos del desfile! 👏'); };
  return m;
}

function missionGrafiti(giver) {
  const pts = [];
  for (let k = 0; k < 4; k++) {
    const pt = randomSidewalkPoint((d, x, y) => d === 'T' && pts.every(q => dist(q.x, q.y, x, y) > 350));
    if (pt) pts.push({ x: pt.x, y: pt.y, text: `Lleva a los turistas al mural ${pts.length + 1}/4 🎨`, onReach() { floater(pt.x, pt.y - 20, '📸 ¡Qué chimba de mural!', '#ff7043'); for (let i = 0; i < 6; i++) addFx('note', pt.x + rand(-20, 20), pt.y + rand(-20, 20), 0, -20, 1); } });
  }
  if (pts.length < 3) return null;
  return missionRoute('grafiti', pts, { timer: 160, pay: 160000, rep: 5, icon: '🎨', doneText: 'Los turistas quedaron enamorados de la 13', reachLine: ['¡Wow, amazing!', '¡Qué colores tan bacanos!', 'Foto, foto, ¡una foto!'] });
}

function missionVendedor(giver) {
  const prod = giver.product || { n: 'mercancía', icon: '🛒', pay: 10000 };
  const pts = [];
  for (let k = 0; k < 5; k++) {
    const pt = randomSidewalkPoint((d, x, y) => districtUnlocked(d) && dist(x, y, giver.x, giver.y) < 1500 && pts.every(q => dist(q.x, q.y, x, y) > 260));
    if (pt) pts.push({ x: pt.x, y: pt.y, text: `Vende ${prod.icon} ${prod.n} en el punto ${pts.length + 1}/5` });
  }
  if (pts.length < 3) return null;
  return missionRoute('vendedor', pts, { timer: 170, stop: true, stopText: 'vender', payEach: prod.pay, pay: 40000, rep: 4, icon: prod.icon, doneText: `¡Vendiste todo el ${prod.n}!`, reachLine: [`¡Lleve su ${prod.n}, bien fresquito!`, '¡A la orden, mi amor!', '¡Barato, barato!'] });
}

function missionGuia() {
  const keys = ['3,1', '8,1', '0,6'].filter(k => PARKS[k]);
  const pts = keys.map(k => { const s = sidewalkCenterOfPark(k, k === '0,6' ? 'E' : 'S'); return { x: s.x, y: s.y, text: `Lleva a los turistas a ${s.name} 📸`, onReach() { floater(s.x, s.y - 20, '📸 ¡Click!', '#26c6da'); } }; });
  return missionRoute('guia', pts, { timer: 210, pay: 250000, rep: 6, icon: '📸', doneText: '¡5 estrellas en la reseña!', reachLine: ['¡Qué belleza de ciudad!', 'Oh, it\'s so hot!', '¿Esto es del siglo XVI? ¡Wow!'] });
}

function missionCarnaval() {
  const y = 6 * PT + 48;
  const m = mkMission('carnaval', { timer: 110, timerMax: 110, data: { got: 0 } });
  G.maicena = 0;
  const bags = [];
  for (let i = 1; i <= 9; i++) for (const off of [-30, 30]) {
    const x = i * PT - 180 + rand(-60, 60), yy = y + off;
    const k = { x, y: yy, amount: 0, t: 999, kind: 'maicena' };
    bags.push(k); G.pickups.push(k);
  }
  const dancers = [];
  m.onStart = () => {
    for (let k = 0; k < 24; k++) {
      const x = rand(PT, 9 * PT), yy = y + (Math.random() < 0.5 ? -64 : 64);
      if (!circleFree(x, yy, 5)) continue;
      const d = new Ped({ x, y: yy, mode: 'dance', look: { skin: pick(SKINS), hair: pick(HAIRS), shirt: pick(['#ffeb3b', '#e53935', '#43a047', '#1e88e5', '#ff6d00']), pants: '#fff' } });
      d.keep = true; d.umbrella = null; d.icon = Math.random() < 0.3 ? '🎭' : null; dancers.push(d); G.peds.push(d);
    }
    notify('🎭 ¡Arrancó el desfile!', '¡Quien lo vive es quien lo goza! Recoge 10 bolsas de maicena.', '#ffeb3b');
  };
  m.steps = [{ x: bags[0].x, y: bags[0].y, cond: () => G.maicena >= 10, text: 'Recoge 10 bolsas de maicena en el desfile 🎭' }];
  m.update = () => {
    const rest = G.pickups.filter(k => k.kind === 'maicena');
    if (rest.length) { const n = rest.sort((a, b) => dist(a.x, a.y, G.player.x, G.player.y) - dist(b.x, b.y, G.player.x, G.player.y))[0]; m.steps[0].x = n.x; m.steps[0].y = n.y; }
    else if (G.maicena < 10) failMission('Se acabaron las bolsas de maicena');
    if (Math.random() < 0.3) addFx('confetti', G.player.x + rand(-200, 200), G.player.y + rand(-150, 150), rand(-20, 20), rand(10, 40), 1.5);
  };
  m.extra = () => `🎭 Maicena: ${G.maicena}/10`;
  m.cleanup = () => { G.pickups = G.pickups.filter(k => k.kind !== 'maicena'); dancers.forEach(d => { d.keep = false; d.mode = 'gone'; }); };
  m.onDone = () => { unlock('carnaval'); completeMission(200000, 6, '¡Quien lo vive es quien lo goza! 🎭'); };
  return m;
}

function missionSalsa() {
  const m = mkMission('salsa', { data: { done: false, acc: 0 } });
  m.steps = [{ cond: () => m.data.done, text: '¡A bailar salsa! Sigue las flechas' }];
  m.onStart = () => {
    fadeTransition(() => startSalsa(acc => { m.data.done = true; m.data.acc = acc; }), '💃 Subiendo a la pista…');
  };
  m.onDone = () => {
    const pct = Math.round(m.data.acc * 100);
    if (m.data.acc >= 0.65) { unlock('salsero'); completeMission(round500(150000 + m.data.acc * 150000), 6, `Precisión ${pct}% · ¡Sos un salsero caleño! 💃`); }
    else failMission(`Precisión ${pct}%: el jurado dijo que bailás como un palo 😂`);
  };
  return m;
}

// ==========================================================================
// 17. MINIJUEGO: CONCURSO DE SALSA
// ==========================================================================
const LANES = ['left', 'down', 'up', 'right'];
const LANE_GLYPH = ['◀', '▼', '▲', '▶'];
const LANE_COLOR = ['#ff4081', '#40c4ff', '#69f0ae', '#ffd740'];
function startSalsa(onDone) {
  const beat = 60 / STATIONS[2].bpm;
  const notes = [];
  let t = 2.2;
  while (notes.length < 46) {
    notes.push({ lane: randi(0, 3), t });
    if (Math.random() < 0.12) notes.push({ lane: randi(0, 3), t });
    t += beat * pick([1, 1, 1, 0.5, 2]);
  }
  G.minigame = { t: 0, notes, hits: 0, perfect: 0, combo: 0, maxCombo: 0, judge: '', judgeT: 0, end: t + 1.5, onDone, win: G.clothes.salsero ? 0.17 : 0.13 };
  Sound.radio.forced = 2;
}
function updateMinigame(dt) {
  const m = G.minigame;
  m.t += dt; m.judgeT -= dt;
  if (Input.hit('esc')) { m.t = m.end; }
  for (let l = 0; l < 4; l++) {
    if (!Input.hit(LANES[l])) continue;
    let best = null, bd = 1e9;
    for (const n of m.notes) if (!n.done && n.lane === l && Math.abs(n.t - m.t) < bd) { bd = Math.abs(n.t - m.t); best = n; }
    if (best && bd < m.win) {
      best.done = true; best.hit = true; m.hits++; m.combo++; m.maxCombo = Math.max(m.maxCombo, m.combo);
      if (bd < m.win * 0.45) { m.perfect++; m.judge = pick(['¡AZÚCAR!', '¡PERFECTO!', '¡SABROSO!', '¡ESO ES!']); } else m.judge = pick(['¡Bien!', '¡Dale!', '¡Ahí vas!']);
      m.judgeT = 0.5;
      m.flash = { lane: l, t: 0.15 };
      Sound.tone(880 + l * 120, 0.05, 'square', 0.04);
    } else { m.combo = 0; m.judge = '¡Uy, te pisaste!'; m.judgeT = 0.5; }
  }
  for (const n of m.notes) if (!n.done && m.t - n.t > m.win) { n.done = true; m.combo = 0; m.judge = 'Fallaste…'; m.judgeT = 0.4; }
  if (m.flash) m.flash.t -= dt;
  if (m.t >= m.end) {
    const acc = m.hits / m.notes.length;
    G.minigame = null; Sound.radio.forced = null;
    m.onDone(acc);
  }
}
function renderMinigame(time) {
  const m = G.minigame;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const W = Math.min(440, VW - 32), H = Math.min(VH - 40, 560), x0 = (VW - W) / 2, y0 = (VH - H) / 2;
  const g = ctx.createLinearGradient(0, y0, 0, y0 + H);
  g.addColorStop(0, 'rgba(60,0,40,.92)'); g.addColorStop(1, 'rgba(10,0,30,.95)');
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 0, VW, VH);
  ctx.fillStyle = g; rr(ctx, x0, y0, W, H, 18);
  // luces de la pista
  for (let k = 0; k < 5; k++) { ctx.fillStyle = `hsla(${(time * 90 + k * 70) % 360},90%,60%,.12)`; circ(ctx, x0 + W * (0.1 + k * 0.2), y0 + 60 + Math.sin(time * 2 + k) * 20, 60); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ff4081'; ctx.font = '800 22px Bungee, Barlow Condensed, sans-serif';
  ctx.fillText('💃 CONCURSO DE SALSA 🕺', VW / 2, y0 + 28);
  const acc = m.notes.filter(n => n.done).length ? Math.round(m.hits / Math.max(1, m.notes.filter(n => n.done).length) * 100) : 100;
  ctx.fillStyle = '#fff'; ctx.font = '700 15px Barlow Condensed, sans-serif';
  ctx.fillText(`Combo ${m.combo} · Precisión ${acc}% · Necesitas 65%`, VW / 2, y0 + 54);
  const laneW = (W - 40) / 4, hitY = y0 + H - 70, top = y0 + 76, speed = (hitY - top) / 1.6;
  for (let l = 0; l < 4; l++) {
    const lx = x0 + 20 + l * laneW;
    ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fillRect(lx + 4, top, laneW - 8, hitY - top + 30);
    const fl = m.flash && m.flash.lane === l && m.flash.t > 0;
    ctx.strokeStyle = LANE_COLOR[l]; ctx.lineWidth = fl ? 5 : 3;
    ctx.beginPath(); ctx.arc(lx + laneW / 2, hitY, 22, 0, TAU); ctx.stroke();
    ctx.fillStyle = LANE_COLOR[l]; ctx.font = '700 18px sans-serif'; ctx.fillText(LANE_GLYPH[l], lx + laneW / 2, hitY + 1);
  }
  for (const n of m.notes) {
    if (n.done && !n.hit) continue;
    if (n.hit) continue;
    const y = hitY - (n.t - m.t) * speed;
    if (y < top - 20 || y > hitY + 40) continue;
    const lx = x0 + 20 + n.lane * laneW + laneW / 2;
    ctx.fillStyle = LANE_COLOR[n.lane]; circ(ctx, lx, y, 19);
    ctx.fillStyle = '#1a0020'; ctx.font = '800 17px sans-serif'; ctx.fillText(LANE_GLYPH[n.lane], lx, y + 1);
  }
  // Bailarines a los lados
  const look1 = { skin: '#c68642', hair: '#111', shirt: '#e91e63', pants: '#111' }, look2 = Object.assign(playerLook(), {});
  drawPersonScaled(x0 - 2 + 0, y0 + H / 2, time, look1);
  drawPersonScaled(x0 + W + 2, y0 + H / 2, time + 1, look2);
  if (m.judgeT > 0) { ctx.fillStyle = '#ffd740'; ctx.font = '800 28px Bungee, sans-serif'; ctx.fillText(m.judge, VW / 2, hitY - 140); }
  ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.font = '600 13px Barlow Condensed, sans-serif';
  ctx.fillText(isTouch() ? 'Toca el carril cuando la nota llegue al círculo' : 'Flechas ← ↓ ↑ → (o A S W D) cuando la nota llegue al círculo', VW / 2, y0 + H - 22);
}
function drawPersonScaled(x, y, time, look) {
  if (x < 20 || x > VW - 20) return;
  ctx.save(); ctx.translate(x, y); ctx.scale(2.4, 2.4);
  drawPerson(ctx, 0, 0, -Math.PI / 2 + Math.sin(time * 6) * 0.6, look, time * 12);
  ctx.restore();
}

// ==========================================================================
// 18. MAPA GRANDE CON ZOOM Y ARRASTRE
// ==========================================================================
function bmFit() {
  const c = $('#bigmap-canvas');
  return Math.min(c.clientWidth / MW, c.clientHeight / MH) * 0.94;
}
function bmInit() {
  const c = $('#bigmap-canvas'), fit = bmFit();
  const narrow = c.clientWidth < 700;
  G.bm = { sc: narrow ? Math.max(fit, (c.clientHeight / MH) * 0.95, 3.2) : fit, cx: G.player.x / T, cy: G.player.y / T };
  bmClamp();
}
function bmClamp() {
  const c = $('#bigmap-canvas'), b = G.bm, fit = bmFit();
  b.sc = clamp(b.sc, fit, 14);
  const hw = c.clientWidth / 2 / b.sc, hh = c.clientHeight / 2 / b.sc;
  b.cx = MW / 2 <= hw ? MW / 2 : clamp(b.cx, hw - 4, MW - hw + 4);
  b.cy = MH / 2 <= hh ? MH / 2 : clamp(b.cy, hh - 4, MH - hh + 4);
}
function bmZoom(f, sx, sy) {
  const c = $('#bigmap-canvas'), b = G.bm;
  sx = sx == null ? c.clientWidth / 2 : sx; sy = sy == null ? c.clientHeight / 2 : sy;
  const wx = b.cx + (sx - c.clientWidth / 2) / b.sc, wy = b.cy + (sy - c.clientHeight / 2) / b.sc;
  b.sc *= f; bmClamp();
  b.cx = wx - (sx - c.clientWidth / 2) / b.sc; b.cy = wy - (sy - c.clientHeight / 2) / b.sc;
  bmClamp(); drawBigMap();
}
function setupBigMapInput() {
  const c = $('#bigmap-canvas');
  const ptrs = new Map();
  let drag = null, pinch = null;
  c.addEventListener('pointerdown', e => {
    c.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (ptrs.size === 1) drag = { x: e.offsetX, y: e.offsetY, cx: G.bm.cx, cy: G.bm.cy, moved: false };
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: dist(a.x, a.y, b.x, b.y), sc: G.bm.sc }; drag = null; }
  });
  c.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pinch && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const f = pinch.sc * dist(a.x, a.y, b.x, b.y) / pinch.d / G.bm.sc;
      bmZoom(f, (a.x + b.x) / 2, (a.y + b.y) / 2);
    } else if (drag) {
      const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
      if (Math.hypot(dx, dy) > 6) drag.moved = true;
      if (drag.moved) { G.bm.cx = drag.cx - dx / G.bm.sc; G.bm.cy = drag.cy - dy / G.bm.sc; bmClamp(); drawBigMap(); }
    }
  });
  const up = e => {
    if (drag && !drag.moved && ptrs.size === 1) bigMapTap(e.offsetX, e.offsetY);
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (!ptrs.size) drag = null;
  };
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', e => { ptrs.delete(e.pointerId); drag = null; pinch = null; });
  c.addEventListener('wheel', e => { e.preventDefault(); bmZoom(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.offsetX, e.offsetY); }, { passive: false });
  $('#bm-in').onclick = () => bmZoom(1.4);
  $('#bm-out').onclick = () => bmZoom(1 / 1.4);
  $('#bm-me').onclick = () => { G.bm.cx = G.player.x / T; G.bm.cy = G.player.y / T; G.bm.sc = Math.max(G.bm.sc, 5); bmClamp(); drawBigMap(); };
}
function bigMapTap(sx, sy) {
  const { sc, ox, oy } = bigMapGeom();
  const x = (sx - ox) / sc * T, y = (sy - oy) / sc * T;
  if (x < 0 || y < 0 || x > WORLD_W || y > WORLD_H) return;
  if (G.waypoint && dist(x, y, G.waypoint.x, G.waypoint.y) < 3 * T) { G.waypoint = null; toast('📍 Destino borrado'); }
  else { G.waypoint = { x, y }; toast('📍 Destino marcado: sigue la línea del GPS'); }
  G.gpsT = 0; updateGPS(0); drawBigMap(); Sound.sfx('click');
}

// ==========================================================================
// 19. RADIO: reguetón, cumbia, salsa y champeta
// ==========================================================================
Object.assign(Sound, {
  kick(w, v = 0.26) { this.tone(62, 0.2, 'sine', v, w, -36, this.radioBus); },
  snare(w, v = 0.11) { this.noise(0.12, v, 1900, 'bandpass', w, this.radioBus); this.tone(200, 0.06, 'triangle', v * 0.4, w, 0, this.radioBus); },
  hat(w, v = 0.025) { this.noise(0.03, v, 7500, 'highpass', w, this.radioBus); },
  note(f, d, type, v, w, slide) { this.tone(f, d, type, v, w, slide || 0, this.radioBus); },
  /** Un paso de semicorchea de la emisora activa. */
  stationStep(t, s) {
    const w = t - this.ctx.currentTime, st = STATIONS[this.radio.forced != null ? this.radio.forced : this.radio.station].id;
    const s16 = s % 16, bar = Math.floor(s / 16) % 4;
    if (st === 'mega') { // dembow
      if (s16 % 4 === 0) this.kick(w);
      if (s16 === 3 || s16 === 6 || s16 === 11 || s16 === 14) this.snare(w);
      if (s16 % 2 === 0) this.hat(w, s16 % 4 === 2 ? 0.035 : 0.018);
      const root = [55, 43.65, 65.41, 49][bar];
      if (s16 === 0) this.note(root, 0.5, 'sine', 0.24, w, -6);
      if (s16 === 7 || s16 === 10) this.note(root, 0.22, 'sine', 0.18, w);
      const motif = [0, -1, 2, -1, 3, -1, 2, 4, -1, 3, -1, 2, 1, -1, 0, -1];
      const sc = [440, 523.25, 587.33, 659.25, 783.99];
      const idx = motif[s16];
      if (idx >= 0 && bar !== 3) this.note(sc[idx] * (bar === 1 ? 0.8909 : 1), 0.14, 'triangle', 0.035, w);
      if (s16 === 0) [220, 261.6, 329.6].forEach(f => this.note(f * [1, 0.8, 1.19, 0.89][bar], 0.9, 'sine', 0.018, w));
    } else if (st === 'tropi') { // cumbia
      if (s16 % 2 === 0) this.radioStep(t, s / 2);
    } else if (st === 'rumba') { // salsa: clave 2-3, campana, tumbao y montuno
      const e = s % 16, bar8 = Math.floor(s / 8) % 4;
      if ([2, 4, 8, 11, 14].includes(e)) this.note(1900, 0.04, 'square', 0.045, w);
      if (e % 2 === 0) this.note(e % 4 === 0 ? 820 : 560, 0.05, 'square', 0.025, w);
      if (e % 8 === 6 || e % 8 === 7) this.note(e % 8 === 6 ? 196 : 247, 0.12, 'sine', 0.09, w, -30);
      const roots = [65.41, 87.31, 98, 65.41], r = roots[bar8];
      if (e % 8 === 3) this.note(r * 1.5, 0.22, 'triangle', 0.13, w);
      if (e % 8 === 6) this.note(roots[(bar8 + 1) % 4], 0.3, 'triangle', 0.14, w);
      const chords = [[523, 659, 784], [523, 698, 880], [494, 587, 784], [523, 659, 784]];
      if ([1, 0, 1, 1, 0, 1, 0, 1][e % 8]) this.note(chords[bar8][(s * 7) % 3], 0.1, 'triangle', 0.03, w);
      if (e % 4 === 0) this.kick(w, 0.1);
    } else { // champeta
      if (s16 === 0 || s16 === 6 || s16 === 8 || s16 === 14) this.kick(w, 0.22);
      if (s16 === 4 || s16 === 12) this.snare(w, 0.08);
      this.hat(w, s16 % 2 ? 0.012 : 0.022);
      const riff = [0, 2, 4, 2, 1, 3, 4, 3, 0, 2, 4, 5, 4, 2, 1, 0], pent = [523.25, 587.33, 659.25, 783.99, 880, 1046.5];
      this.note(pent[riff[s16]] * (bar % 2 ? 1.122 : 1), 0.08, 'square', 0.02, w);
      const roots = [65.41, 87.31, 98, 65.41];
      if (s16 === 0 || s16 === 8) this.note(roots[bar], 0.3, 'triangle', 0.15, w);
      if (s16 === 10) this.note(roots[bar] * 1.5, 0.15, 'triangle', 0.1, w);
    }
  },
});

// ==========================================================================
// 12. GUARDADO
// ==========================================================================
function saveGame() {
  if (G.state !== 'play') return;
  if (G.outVeh && G.garage[G.outVeh.ownIdx]) G.garage[G.outVeh.ownIdx].hp = G.outVeh.hp;
  const p = G.player;
  const data = {
    v: 1, name: G.name, shirt: G.shirt, money: G.money, rep: G.rep, day: G.day, minutes: G.minutes,
    health: p.health, energy: p.energy, phone: G.phone, clothes: G.clothes, homes: G.homes, home: G.home,
    biz: G.biz, inv: G.inv, invCost: G.invCost, garage: G.garage, stats: G.stats, ach: G.ach, visited: G.visited,
    unlockedSeen: G.unlockedSeen, muted: Sound.muted, radio: Sound.radio.on, station: Sound.radio.station, savedAt: Date.now(),
    city: G.city, cityVisited: G.cityVisited, weapons: G.weapons, ammo: G.ammo, weapon: G.weapon,
  };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (e) { /* almacenamiento lleno o bloqueado */ }
}
function loadSave() {
  try { const d = JSON.parse(localStorage.getItem(SAVE_KEY)); return d && d.v === 1 ? d : null; } catch (e) { return null; }
}

// ==========================================================================
// 13. BUCLE PRINCIPAL E INICIO
// ==========================================================================
function resetRun() {
  G.vehicles = []; G.peds = []; G.pickups = []; G.fx = []; G.floaters = []; G.bubbles = []; G.skids = [];
  G.bullets = []; G.grenades = []; G.scorch = []; G.carry = null; G.minigame = null; Sound.radio.forced = null;
  G.mission = null; G.offers = null; G.wanted = 0; G.unseen = 0; G.peakWanted = 0; G.bustT = 0; G.overlay = null;
  for (const k of ['checkpoint', 'closed', 'festival', 'jam']) {
    if (k === 'closed' && G.events.closed) { for (const i of G.events.closed.tiles) World.dyn[i] = 0; World.closed.delete(G.events.closed.key); }
    G.events[k] = null;
  }
  G.events.bonus = 0; G.events.strike = 0; G.eventT = 50; G.outVeh = null; G.waypoint = null; G.forceStorm = false;
  G.districtNow = null;
}

function startGame(save) {
  resetRun();
  const d = save || {};
  G.name = d.name || ($('#name-input').value.trim() || 'Parce').slice(0, 14);
  G.shirt = d.shirt || G.shirt;
  G.money = d.money != null ? d.money : 50000;
  G.rep = d.rep || 0; G.day = d.day || 1; G.minutes = d.minutes != null ? d.minutes : 7 * 60;
  G.phone = d.phone || 0; G.clothes = d.clothes || {}; G.homes = d.homes || { kennedy: true }; G.home = d.home || 'kennedy';
  G.biz = d.biz || {}; G.inv = d.inv || {}; G.invCost = d.invCost || {}; G.garage = d.garage || [];
  G.stats = Object.assign({ deliveries: 0, missions: 0, earned: 0, potholes: 0, hustle: 0, busted: 0, wasted: 0, played: 0 }, d.stats || {});
  G.ach = d.ach || {}; G.visited = d.visited || {}; G.unlockedSeen = d.unlockedSeen || {};
  if (save) { Sound.muted = !!d.muted; Sound.radio.on = d.radio !== false; }
  G.weather = 'sol'; G.weatherT = 120; G.rain = 0; G.wetness = 0;
  G.city = CITIES[d.city] && CITY_ORDER.includes(d.city) ? d.city : 'bogota';
  G.cityVisited = d.cityVisited || { bogota: true }; G.weapons = d.weapons || { punos: true }; G.ammo = d.ammo || {}; G.weapon = d.weapon || 'punos';
  if (save) Sound.radio.station = d.station || 0;
  if (CITY.id !== G.city) { applyCity(G.city); genWorld(); buildMiniBase(); }
  // Las partidas viejas guardaban barrios sin ciudad
  for (const k of Object.keys(G.visited)) if (k.length === 1) { G.visited['bogota:' + k] = true; delete G.visited[k]; }
  const home = G.city === 'bogota' ? (poi('home_' + G.home) || poi('home_kennedy')) : poi('hotel');
  G.player = newPlayer(home.x, home.y);
  if (save) { G.player.health = d.health || 100; G.player.energy = d.energy != null ? Math.max(20, d.energy) : 100; }
  cam.x = home.x; cam.y = home.y; cam.zoom = cam.base;
  G.state = 'play';
  $('#title').hidden = true; $('#hud').hidden = false;
  document.body.classList.add('playing');
  minimapDirty = true;
  if (!save) {
    G.waypoint = { x: poi('g_domi').x, y: poi('g_domi').y };
    setTimeout(() => notify(`🇨🇴 ¡Bienvenido a Bogotá, ${esc(G.name)}!`, 'Arrancas con $50.000 y una pieza arrendada en Kennedy. ¡A camellar!', '#ffd54f'), 600);
    setTimeout(() => notify('🛵 Tu primer camello', 'Ve a la Central de Domicilios (sigue la flecha amarilla) y presiona E.', '#ff6f3c'), 3200);
    if (isTouch()) {
      setTimeout(() => toast('Muévete con el joystick · 🏃 para correr · 🚗 para subirte a vehículos'), 7000);
      setTimeout(() => toast('📱 celular · 🗺️ mapa · ⏸ pausa'), 11500);
    } else {
      setTimeout(() => toast('Camina con WASD o flechas · Shift para correr · F para subirte a vehículos'), 6500);
      setTimeout(() => toast('M abre el mapa · C el celular · Esc la pausa'), 10500);
    }
  } else notify(`👋 ¡Qué más, ${esc(G.name)}!`, `Día ${G.day} · ${fmtMoney(G.money)} · ${G.rep} ⭐`, '#ffd54f');
  saveGame();
}

function toTitle() {
  G.state = 'title';
  resetRun();
  G.player = newPlayer(WORLD_W / 2, WORLD_H / 2);
  $('#hud').hidden = true; $('#title').hidden = false;
  document.body.classList.remove('playing');
  closeBigMap();
  refreshTitle();
}
function refreshTitle() {
  const s = loadSave();
  const btn = $('#btn-continue');
  btn.hidden = !s;
  if (s) btn.querySelector('small').textContent = `${s.name} · Día ${s.day} · ${fmtMoney(s.money)} · ${s.rep} ⭐`;
  G.minutes = 20 * 60 + 30; G.weather = 'lluvia'; G.rain = 0.45; G.wetness = 1; G.weatherT = 1e9;
}

/** Recorrido de cámara por la ciudad en la pantalla de título. */
const TITLE_PATH = [[30, 99], [66, 99], [66, 40], [100, 40], [100, 70], [130, 70], [130, 112], [66, 112]];
let titleSeg = 0, titleK = 0;
function titleUpdate(dt) {
  const a = TITLE_PATH[titleSeg], b = TITLE_PATH[(titleSeg + 1) % TITLE_PATH.length];
  const L = dist(a[0], a[1], b[0], b[1]) * T;
  titleK += dt * 70 / L;
  if (titleK >= 1) { titleK = 0; titleSeg = (titleSeg + 1) % TITLE_PATH.length; }
  cam.x = lerp(a[0], b[0], titleK) * T; cam.y = lerp(a[1], b[1], titleK) * T; cam.zoom = cam.base * 0.9;
  G.focus.x = cam.x; G.focus.y = cam.y;
  G.player.x = cam.x; G.player.y = cam.y;
  manageWorld(dt);
  updateVehicles(dt);
  for (const pd of G.peds) updatePed(pd, dt);
  updateFx(dt);
}

function handleGlobalKeys() {
  if (G.minigame) return true;
  if (G.menu) { menuInput(); return true; }
  if (G.bigmap) { if (Input.hit('m', 'esc')) closeBigMap(); return true; }
  if (G.overlay || G.fading) return true;
  if (Input.hit('esc')) { openMenu(menuPause()); return true; }
  if (Input.hit('m')) { openBigMap(); return true; }
  if (Input.hit('c')) { openMenu(menuPhone()); return true; }
  if (Input.hit('n')) { Sound.setMuted(!Sound.muted); toast(Sound.muted ? '🔇 Sonido apagado' : '🔊 Sonido encendido'); }
  if (Input.hit('r')) {
    const R = Sound.radio;
    if (!R.on) { R.on = true; R.station = 0; } else if (R.station < STATIONS.length - 1) R.station++; else R.on = false;
    toast(R.on ? `📻 ${STATIONS[R.station].name}` : '📻 Radio apagada');
  }
  if (Input.hit('f')) { if (!G.player.hidden) tryToggleVehicle(); }
  if (Input.hit('e') && !G.player.hidden) {
    const q = nearestPOI();
    if (q) interact(q); else tryToggleVehicle();
  }
  return false;
}

let lastSecond = 0;
function update(dt) {
  if (G.state === 'title') { titleUpdate(dt); return; }
  if (G.state !== 'play') return;
  if (G.minigame && !G.fading) { updateMinigame(dt); return; }
  if (handleGlobalKeys()) {
    if (G.overlay) { updateOverlay(dt); updateFx(dt); }
    return;
  }
  const p = G.player;
  G.stats.played += dt;
  updateTime(dt); updateWeather(dt);
  updatePlayer(dt); updateVitals(dt);
  // Armas
  G.fireCD -= dt; G.flash = Math.max(0, G.flash - dt * 2);
  if (Input.hit('q')) cycleWeapon();
  if (p.onFoot && !p.hidden && Input.down('fire') && G.fireCD <= 0) playerAttack();
  if (p.punchT > 0) p.punchT -= dt;
  updateVehicles(dt);
  for (const pd of G.peds) updatePed(pd, dt);
  updateBullets(dt);
  for (const sc of G.scorch) sc.t -= dt;
  G.scorch = G.scorch.filter(sc => sc.t > 0);
  // La gente habla como se habla en cada ciudad
  G.chatT -= dt;
  if (G.chatT <= 0) {
    G.chatT = rand(4, 8);
    const near = G.peds.filter(o => o.mode === 'walk' && dist(o.x, o.y, p.x, p.y) < 240 && onScreen(o.x, o.y, -20));
    if (near.length) bubble(pick(near), pick(CITY.sayings));
  }
  updateWanted(dt); updateMission(dt); updateEvents(dt); updatePickups(dt);
  G.focus.x = p.x; G.focus.y = p.y;
  manageWorld(dt); updateFx(dt); updateCamera(dt); updateGPS(dt);
  G.offersT -= dt;
  // Barrio actual
  const d = districtAt(p.x, p.y);
  if (d !== G.districtNow) {
    G.districtNow = d; districtBanner(d);
    const vk = CITY.id + ':' + d;
    if (!G.visited[vk]) { G.visited[vk] = true; if (Object.keys(G.visited).filter(k => k.startsWith('bogota:')).length >= 8) unlock('rolo'); }
  }
  // Aviso de barrio bloqueado
  G.lockToastT -= dt;
  if (G.lockHint && G.lockToastT <= 0) {
    const info = DISTRICTS[G.lockHint];
    toast(`🔒 ${info.name}: necesitas ${info.rep} ⭐ de reputación (tienes ${G.rep})`);
    G.lockToastT = 3;
  }
  G.lockHint = null;
  // Llegar al destino del GPS
  if (G.waypoint && !G.mission && dist(p.x, p.y, G.waypoint.x, G.waypoint.y) < 40) G.waypoint = null;
  lastSecond += dt;
  if (lastSecond > 1) { lastSecond = 0; checkUnlocks(); }
  G.saveT -= dt;
  if (G.saveT <= 0) { G.saveT = 30; saveGame(); }
}

let lastT = 0, acc = 0;
function frame(ts) {
  const t = ts / 1000;
  let dt = Math.min(0.05, t - lastT || 0.016);
  lastT = t;
  update(dt);
  render(t, dt);
  if (G.state === 'play') {
    updateHUD();
    drawMinimap(t);
    if (G.bigmap) { acc += dt; if (acc > 0.25) { acc = 0; drawBigMap(); } }
    // Overlay de hospital / policía
    const ov = $('#overlay');
    if (G.overlay) {
      if (ov.hidden) { ov.hidden = false; ov.className = G.overlay.type; ov.querySelector('.ov-title').textContent = G.overlay.title; ov.querySelector('.ov-sub').textContent = G.overlay.sub; }
    } else if (!ov.hidden) ov.hidden = true;
  }
  Sound.update(dt);
  Input.clear();
  requestAnimationFrame(frame);
}

function init() {
  cv = $('#game'); ctx = cv.getContext('2d');
  lc = document.createElement('canvas'); lctx = lc.getContext('2d');
  genWorld();
  buildMiniBase();
  resize();
  window.addEventListener('resize', resize);
  setupTouch();
  G.player = newPlayer(WORLD_W / 2, WORLD_H / 2);
  refreshTitle();
  // Pantalla de título
  const sw = $('#swatches');
  ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#fb8c00', '#00acc1', '#f5f5f5'].forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (i === 0 ? ' on' : ''); b.style.background = c; b.setAttribute('aria-label', 'Color ' + c);
    b.onclick = () => { G.shirt = c; sw.querySelectorAll('.swatch').forEach(x => x.classList.remove('on')); b.classList.add('on'); Sound.init(); Sound.sfx('click'); };
    sw.appendChild(b);
  });
  // Confirmación dentro de la página (no se usa confirm(): algunos visores lo bloquean)
  let sureNew = false;
  $('#btn-new').onclick = () => {
    Sound.init();
    if (loadSave() && !sureNew) {
      sureNew = true;
      $('#btn-new').textContent = '⚠ Toca otra vez: se borra la partida guardada';
      setTimeout(() => { sureNew = false; $('#btn-new').textContent = '★ Nueva partida'; }, 4000);
      return;
    }
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { }
    startGame(null);
  };
  $('#btn-continue').onclick = () => { Sound.init(); const s = loadSave(); if (s) startGame(s); };
  $('#btn-help').onclick = () => { $('#help').hidden = !$('#help').hidden; Sound.init(); };
  // Menú: clics
  $('#menu').addEventListener('click', e => {
    const x = e.target.closest('[data-close]');
    if (x) { closeMenu(); return; }
    const b = e.target.closest('[data-b]');
    if (b) { G.menu.sel = +b.dataset.i; G.menu.bsel = +b.dataset.b; activate(+b.dataset.i, +b.dataset.b); return; }
    const it = e.target.closest('.menu-item');
    if (it && !e.target.closest('.mi-btns')) { G.menu.sel = +it.dataset.i; activate(+it.dataset.i, 0); }
  });
  // Mapa grande: arrastrar, zoom y toque = destino
  setupBigMapInput();
  $('#minimap-wrap').addEventListener('click', () => { if (G.state === 'play' && !G.menu) openBigMap(); });
  // Mouse: apuntar y disparar
  cv.addEventListener('mousemove', e => { G.mouse = { sx: e.clientX, sy: e.clientY, t: performance.now() }; });
  cv.addEventListener('mousedown', e => { if (e.button !== 0 || G.state !== 'play') return; Sound.init(); G.mouse = { sx: e.clientX, sy: e.clientY, t: performance.now() }; Input.keys.fire = true; Input.hits.fire = true; });
  window.addEventListener('mouseup', () => { Input.keys.fire = false; });
  cv.addEventListener('contextmenu', e => e.preventDefault());
  $('#bigmap .bm-close').onclick = closeBigMap;
  requestAnimationFrame(frame);
}
window.addEventListener('load', init);
