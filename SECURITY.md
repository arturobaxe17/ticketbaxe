# Seguridad y datos personales

Esta aplicación gestiona nombres y documentos identificativos. No debe publicarse ni utilizarse con datos reales hasta completar la configuración y las comprobaciones indicadas en `README.md`.

## Controles incluidos

- Los responsables acceden mediante códigos aleatorios de grupo. En la base de datos solo se conserva un HMAC del código, nunca el código en texto claro.
- Los códigos de acceso se muestran una sola vez. Al renovarlos, el anterior deja de funcionar y las sesiones anteriores se revocan.
- Las sesiones del portal caducan a las 12 horas y se guardan como hashes HMAC.
- Los DNI/NIE/pasaportes se cifran con AES-256-GCM en Edge Functions. La clave de cifrado nunca llega al navegador.
- Para detectar duplicados se almacena un HMAC del documento normalizado, no un hash simple susceptible a búsquedas por diccionario.
- Las tablas tienen RLS activado y se revoca el acceso directo a `anon` y `authenticated`. El cliente no consulta tablas: llama a Edge Functions.
- La administración valida el rol `app_metadata.role=admin` y exige un JWT con `aal2` (MFA).
- El servidor comprueba el plazo de modificación en cada escritura. Desactivar un botón en la interfaz no es el mecanismo de seguridad.
- Las altas simultáneas bloquean la fila del evento durante la comprobación del aforo y los documentos activos tienen una restricción única por evento.
- Las versiones oficiales se guardan como snapshots cifrados independientes. Reabrir y volver a cerrar crea una versión nueva; no sustituye las anteriores.
- Se registran accesos y cambios importantes sin incluir el número de documento en el registro de auditoría.

## Límites que requieren configuración operativa

- El código de grupo funciona como una contraseña compartida por el responsable. Quien lo reciba puede actuar como ese grupo hasta que se revoque. Entrégalo por privado y renóvalo ante cualquier sospecha.
- El responsable debe confirmar con los asistentes que está autorizado para comunicar sus datos y la organización debe determinar y documentar la base jurídica, la información de privacidad y el tiempo de conservación.
- El administrador debe proteger su correo, contraseña y aplicación TOTP. No compartas la cuenta de administración.
- La limitación de intentos usa la IP que comunica el proxy de Supabase. Configura correctamente el dominio y `ALLOWED_ORIGIN`.
- Las copias de seguridad administradas por Supabase y su retención dependen del plan y la configuración del proyecto. Exporta y conserva las listas oficiales en un lugar seguro antes de cada evento.
- Los controles de acceso y cifrado del código no sustituyen la revisión de dependencias, pruebas de penetración ni auditoría profesional antes de procesar DNI reales.
- Un snapshot conserva datos personales cifrados. Define un plazo de conservación y elimina datos cuando ya no sean necesarios para la finalidad del evento.
- Una exportación CSV contiene documentos en texto claro. Guárdala en dispositivos protegidos y bórrala cuando deje de ser necesaria.
- Esta implementación es una base técnica; no sustituye una auditoría de seguridad, asesoramiento RGPD ni una evaluación legal de la necesidad de recoger el DNI de cada asistente.
