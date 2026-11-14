import { validateDocument } from '../functions/_shared/common.ts';

Deno.test('acepta y normaliza un DNI válido', () => {
  const result = validateDocument('DNI', '00000000t');
  if (result !== '00000000T') throw new Error(`Resultado inesperado: ${result}`);
});

Deno.test('rechaza una letra de DNI incorrecta', () => {
  let rejected = false;
  try { validateDocument('DNI', '00000000A'); } catch { rejected = true; }
  if (!rejected) throw new Error('Se aceptó un DNI con letra incorrecta.');
});

Deno.test('acepta un NIE válido', () => {
  const result = validateDocument('NIE', 'X0000000T');
  if (result !== 'X0000000T') throw new Error(`Resultado inesperado: ${result}`);
});

Deno.test('rechaza un documento duplicable con espacios o guiones de forma normalizada', () => {
  const result = validateDocument('DNI', ' 00 000 000-T ');
  if (result !== '00000000T') throw new Error(`Resultado inesperado: ${result}`);
});

Deno.test('acepta pasaporte alfanumérico', () => {
  const result = validateDocument('PASSPORT', ' ab123456 ');
  if (result !== 'AB123456') throw new Error(`Resultado inesperado: ${result}`);
});
