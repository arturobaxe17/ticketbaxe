# TicketBaxe 🎄

Aplicación web privada para gestionar los asistentes de conciertos, Nochebuena, Nochevieja y otros eventos.

Cada responsable recibe un **identificador único de grupo**. Con ese código entra en su portal y administra únicamente las personas de su grupo y los eventos que la organización le haya asignado. Cada persona activa representa una entrada y lleva nombre, tipo de documento, DNI/NIE/pasaporte y estado de confirmación.

## Funcionalidades incluidas

### Portal de responsables (`/`)

- Acceso mediante identificador privado, sin que el responsable tenga que crear una cuenta.
- Un identificador por grupo, válido para todos los eventos asignados a ese grupo.
- Vista de eventos con fecha, hora, plazas ocupadas y plazo de modificación.
- Añadir, corregir y cancelar asistentes.
- Validación matemática de DNI/NIE españoles y validación de formato de pasaporte. La comprobación de la letra de control no demuestra que un documento pertenezca a una persona real; para eso haría falta una verificación oficial de identidad.
- Aviso de documentos duplicados dentro de un mismo evento.
- Avisos administrativos de posibles nombres repetidos, ignorando tildes, mayúsculas y signos; son advertencias, no bloqueos.
- Estados confirmado, pendiente y cancelado.
- El responsable puede consultar por persona si la organización ha marcado su entrada como pagada; no puede cambiar ese dato.
- El responsable también se puede añadir como asistente; no se cuenta automáticamente por el mero hecho de ser responsable.
- Sesión de portal con caducidad de 12 horas.

### Administración (`/admin`)

- Acceso mediante usuario administrador de Supabase y segundo factor TOTP obligatorio.
- Crear eventos con fecha, hora, fecha límite de edición, aforo opcional y cartel JPG/PNG/WEBP (máximo 5 MB).
- Publicar u ocultar eventos desde el panel sin borrar sus datos ni su historial.
- Marcar individualmente a cada asistente como pagado o pendiente; el responsable ve el estado desde su acceso.
- Crear grupos y asignarles uno o varios eventos.
- Generar, renovar y revocar códigos de grupo. El código completo solo se muestra una vez.
- Bloquear o activar grupos.
- Consultar todas las listas. Para corregir una lista cerrada, primero hay que reabrir el evento con un nuevo plazo; así no se altera silenciosamente una lista oficial.
- Cerrar un evento manualmente y generar una lista oficial inmutable.
- Reabrir un evento con una nueva fecha límite y publicar después una nueva versión oficial.
- Descargar snapshots oficiales en CSV compatible con Excel.
- Consultar el historial de actividad.

### Reglas importantes

- El cierre se comprueba en el servidor. Aunque alguien conserve la página abierta, no podrá guardar una modificación después de la fecha límite.
- Una persona cancelada no cuenta como entrada activa y su registro queda en el historial.
- Un mismo documento no puede tener dos registros activos en el mismo evento, aunque lo intenten desde grupos distintos.
- El aforo se comprueba también en base de datos para evitar que dos altas simultáneas ocupen la misma última plaza.
- El estado de pago solo puede modificarlo un administrador con MFA; se muestra en el portal del grupo y se conserva en las listas oficiales.
- El bucket público `event-posters` solo permite lectura pública de imágenes. Las subidas, cambios y borrados requieren una sesión de administrador con MFA.
- El CSV oficial siempre procede de un snapshot cifrado. Las correcciones posteriores requieren publicar una nueva versión.
- Una exportación CSV contiene datos personales en texto claro: protégela y elimínala cuando ya no sea necesaria.

## Arquitectura

- Frontend: React + TypeScript + Vite.
- Backend: Supabase Edge Functions (Deno).
- Base de datos: PostgreSQL de Supabase.
- Códigos de acceso y sesiones: HMAC-SHA-256.
- Documentos identificativos: AES-256-GCM; índice de duplicados mediante HMAC.
- Protección de administración: Supabase Auth + MFA TOTP + `app_metadata.role=admin` + nivel `aal2`.
- Automatización del cierre: GitHub Actions cada cinco minutos. El bloqueo de edición es inmediato en el servidor, sin depender de que se ejecute el cron puntual.

La aplicación no necesita una base de datos ni un servidor de pago adicional al proyecto Supabase. Los límites y condiciones del plan de Supabase pueden cambiar; revisa el uso y los límites vigentes en tu cuenta antes de abrir el registro a muchos usuarios.

---

# Puesta en marcha (Supabase online)

TicketBaxe utiliza el proyecto Supabase alojado en la nube. No necesita Supabase local, Docker ni ejecutar migraciones desde un ordenador.

## 1. Proyecto Supabase conectado

El proyecto online ya está configurado. Se han aplicado las migraciones:

- Esquema inicial, tablas, restricciones de aforo, índices y RLS.
- Estado de pago individual por asistente.
- Carteles y publicación/ocultación de eventos.
- Secretos privados en Supabase Vault.
- Protección de funciones y rutas de base de datos.
- Cierre automático programado cada cinco minutos con Supabase Cron.

Las tablas privadas tienen RLS activado y no conceden acceso directo a los roles del navegador. La aplicación consulta y modifica los datos a través de Edge Functions.

## 2. Crear el primer administrador

1. En Supabase abre **Authentication → Users** y crea el usuario administrador con su correo.
2. Habilita el segundo factor TOTP para esa cuenta.
3. En **SQL Editor**, asigna el rol `admin` a ese correo ejecutando lo siguiente y sustituyendo el correo de ejemplo:

```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
where email = 'TU_CORREO_REAL';
```

4. Inicia sesión en `/admin` y completa la configuración TOTP.

El rol se guarda en `app_metadata`, nunca en `user_metadata`, porque este último puede ser modificado por el propio usuario.

## 3. Secretos y cifrado

Los secretos de la aplicación se generan y almacenan en **Supabase Vault**. Las Edge Functions los leen mediante una función SQL restringida al rol interno `service_role`.

Incluyen:

- Clave AES-256-GCM para cifrar documentos.
- Claves HMAC para detectar documentos duplicados, proteger sesiones y códigos privados.
- Secreto para autorizar los cierres automáticos.

No copies estas claves a GitHub, al navegador ni a archivos públicos. No cambies la clave de cifrado después de almacenar documentos, porque impediría descifrar los datos existentes.

## 4. Edge Functions y cierres automáticos

Las funciones `admin`, `portal` y `close-due-events` están desplegadas en el proyecto alojado.

- `admin` valida la sesión de Supabase Auth, el rol de administrador y MFA `aal2`.
- `portal` valida los códigos privados de grupo y sus sesiones.
- `close-due-events` valida su secreto propio de cierre.

Supabase Cron ejecuta la revisión cada cinco minutos mediante `pg_cron` y `pg_net`. La base de datos impide modificar listas en cuanto vence el plazo, aunque el snapshot oficial automático se genere en la siguiente ejecución.

## 5. Frontend y publicación

El frontend está conectado al proyecto Supabase online mediante su URL y clave pública `publishable`. Esa clave es pública y tiene permisos limitados por RLS; nunca debe sustituirse por una clave `secret` o `service_role`.

El repositorio incluye `netlify.toml` y una comprobación de compilación en GitHub Actions. Netlify debe compilar con `npm run build` y publicar la carpeta `dist`. Si se configuran variables de entorno en Netlify, pueden sobrescribir `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`.

No se necesita instalar ni ejecutar Supabase local para mantener el proyecto.

---

# Publicar el proyecto en GitHub

Desde la carpeta del proyecto:

```bash
git init
git add .
git commit -m "Initial commit: TicketBaxe"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/ticketbaxe.git
git push -u origin main
```

Crea primero un repositorio vacío en GitHub con el nombre que prefieras y sustituye la URL del ejemplo por la tuya.

---

# Flujo de uso recomendado

1. El administrador crea los eventos y define la hora límite de cada uno.
2. Crea un grupo por cada responsable y selecciona los eventos a los que tendrá acceso.
3. Copia el identificador que aparece una sola vez y se lo envía por privado.
4. El responsable entra en el portal, revisa los eventos y añade una ficha por cada persona que va a asistir (nombre, tipo y número de documento). Debe añadir también su propio nombre si va a acudir; no se añade automáticamente.
5. Cada ficha activa representa una entrada. Los estados pueden ser confirmados o pendientes; los cancelados no cuentan como entradas activas. El responsable debe contar con autorización y una base jurídica válida para facilitar los datos personales a la organización.
6. Al llegar el límite, se bloquea la edición en servidor. El sistema crea el snapshot oficial de forma programada o cuando se abre el panel administrativo.
7. El administrador descarga el CSV oficial y lo guarda en un lugar protegido.
8. Si autoriza una modificación extraordinaria, reabre el evento, establece un nuevo límite y vuelve a cerrar/publicar. La versión oficial nueva será la vigente, pero la anterior seguirá disponible.

# Comprobaciones antes de usar con datos reales

- Probar con dos grupos y confirmar que cada uno solo ve su información.
- Probar un código incorrecto repetidamente y comprobar el bloqueo temporal.
- Comprobar que DNI/NIE incorrectos se rechazan y que un documento duplicado en otro grupo también se rechaza.
- Probar dos altas al mismo tiempo cuando queda una sola plaza.
- Mantener una página abierta hasta superar el plazo y comprobar que el servidor rechaza el guardado.
- Cerrar, reabrir, corregir y generar una segunda versión oficial.
- Comprobar la descarga CSV y la recuperación de copias de seguridad.
- Confirmar la zona horaria y el dominio permitido.
- Definir y documentar la base jurídica, la información a los asistentes, el plazo de conservación y el procedimiento de atención de derechos RGPD.

## Estado del proyecto

Este repositorio contiene una primera implementación funcional prevista para desplegarse en Supabase + Netlify. En el entorno de generación no se pudo descargar el registro de paquetes de npm, por lo que no se ha podido ejecutar aquí `npm install` ni verificar un `npm run build`. Haz esa comprobación en tu equipo o en CI antes de cargar datos reales. Revisa también la configuración de seguridad y los requisitos RGPD con la organización responsable.
