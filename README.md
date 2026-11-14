# TicketBaxe 🎄

Aplicación web privada para gestionar los asistentes de conciertos, Nochebuena, Nochevieja y otros eventos.

Cada responsable recibe un **identificador único de grupo**. Con ese código entra en su portal y administra únicamente las personas de su grupo y los eventos que la organización le haya asignado. Cada persona activa representa una entrada y lleva nombre, tipo de documento, DNI/NIE/pasaporte y estado de confirmación.

## Funcionalidades incluidas

### Portal de responsables (`/`)

- Acceso mediante identificador privado, sin que el responsable tenga que crear una cuenta.
- Un identificador por grupo, válido para todos los eventos asignados a ese grupo.
- Vista de eventos con fecha, hora, plazas ocupadas y plazo de modificación.
- Añadir, corregir y cancelar asistentes.
- Validación de DNI y NIE españoles, y validación básica de pasaporte.
- Aviso de documentos duplicados dentro de un mismo evento.
- Estados confirmado, pendiente y cancelado.
- El responsable también se puede añadir como asistente; no se cuenta automáticamente por el mero hecho de ser responsable.
- Sesión de portal con caducidad de 12 horas.

### Administración (`/admin`)

- Acceso mediante usuario administrador de Supabase y segundo factor TOTP obligatorio.
- Crear eventos con fecha, hora, fecha límite de edición y aforo opcional.
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

# Puesta en marcha

## 1. Crear el proyecto Supabase

1. Crea un proyecto en Supabase.
2. En **Project Settings → API**, copia la URL del proyecto y la clave pública `anon` (o publishable compatible).
3. Comprueba que el proveedor Email está habilitado en **Authentication → Providers**.
4. Mantén habilitado TOTP/MFA para usuarios de administración.

No introduzcas nunca la `service_role` o `secret key` en archivos `VITE_*`, en GitHub ni en el código del navegador.

## 2. Crear las tablas

Con Supabase CLI instalado y autenticado, desde la raíz del proyecto:

```bash
supabase login
supabase link --project-ref TU_PROJECT_REF
supabase db push
```

La migración `supabase/migrations/0001_initial_schema.sql` crea el esquema, índices, restricciones de aforo, control de duplicados, RLS y las funciones de limitación de intentos.

## 3. Crear el primer administrador

1. En Supabase abre **Authentication → Users** y crea/invita el usuario administrador con su correo.
2. Abre **SQL Editor** y ejecuta `supabase/ADMIN_SETUP.sql`, sustituyendo el correo de ejemplo por el correo real del administrador.
3. Cierra la sesión si estaba abierta y vuelve a entrar desde `https://TU-DOMINIO/admin`.
4. La primera entrada pedirá configurar TOTP con una app de autenticación. Escanea el QR y confirma el código de seis cifras.

El usuario debe tener `app_metadata.role = admin`. No uses `user_metadata` para el rol, porque el usuario podría modificar sus propios metadatos.

## 4. Configurar secretos de las Edge Functions

Genera valores aleatorios nuevos. Ejecuta cada comando y guarda las claves de cifrado en un gestor seguro, fuera del repositorio:

```bash
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
openssl rand -base64 32
openssl rand -hex 32
```

Configura los valores resultantes (cada valor debe ser distinto):

```bash
supabase secrets set \
  CODE_HASH_SECRET="PEGA_AQUI_EL_PRIMER_HEX" \
  SESSION_HASH_SECRET="PEGA_AQUI_EL_SEGUNDO_HEX" \
  DNI_HASH_SECRET="PEGA_AQUI_EL_TERCER_HEX" \
  DNI_ENCRYPTION_KEY="PEGA_AQUI_EL_BASE64_DE_32_BYTES" \
  CRON_SECRET="PEGA_AQUI_EL_ULTIMO_HEX" \
  ALLOWED_ORIGIN="https://TU-DOMINIO"
```

`DNI_ENCRYPTION_KEY` debe ser una cadena Base64 que represente exactamente 32 bytes. No la cambies una vez que haya documentos guardados: perderla o sustituirla hará que los DNI y las snapshots antiguas no se puedan descifrar.

Si vas a usar la aplicación localmente, puedes añadir el origen local separado por coma, por ejemplo:

```text
ALLOWED_ORIGIN=https://tu-dominio.netlify.app,http://localhost:5173
```

Las Edge Functions necesitan las claves de Supabase que proporciona la plataforma. En proyectos antiguos se expone `SUPABASE_SERVICE_ROLE_KEY`; en la configuración actual puede aparecer como `SUPABASE_SECRET_KEYS`. El código contempla ambos formatos.

## 5. Desplegar las Edge Functions

```bash
supabase functions deploy portal --no-verify-jwt
supabase functions deploy admin --no-verify-jwt
supabase functions deploy close-due-events --no-verify-jwt
```

Las funciones usan `verify_jwt = false` en `supabase/config.toml` porque `portal` utiliza su propia sesión de grupo y `admin` valida manualmente el JWT, el rol y `aal2`. La función de cierres valida un secreto propio. No elimines esas comprobaciones del código.

## 6. Configurar el frontend en local

Se necesita Node.js 22.12 o posterior (requisito de la versión de Vite incluida). Copia `.env.example` a `.env` y rellena los datos públicos del proyecto:

```env
VITE_SUPABASE_URL=https://TU-PROYECTO.supabase.co
VITE_SUPABASE_ANON_KEY=TU_ANON_O_PUBLISHABLE_KEY
```

Después:

```bash
npm install
npm run dev
```

- Portal de responsables: `http://localhost:5173/`
- Administración: `http://localhost:5173/admin`

Para comprobar la versión de producción:

```bash
npm run build
npm run preview
```

## 7. Publicar en Netlify

El repositorio incluye `netlify.toml` para compilar y servir la SPA.

1. Sube el código a un repositorio de GitHub.
2. En Netlify selecciona **Add new site → Import an existing project** y conecta el repositorio.
3. Configura estas variables de entorno en Netlify:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Usa `npm run build` como comando y `dist` como directorio de publicación (ya están declarados en `netlify.toml`).
5. Añade el dominio final a `ALLOWED_ORIGIN` en Supabase y vuelve a desplegar las funciones si has cambiado ese secreto.

## 8. Automatizar el cierre de listas con GitHub Actions

El repositorio contiene `.github/workflows/close-due-events.yml`. En GitHub, abre **Settings → Secrets and variables → Actions** y añade:

- `SUPABASE_URL`: URL del proyecto Supabase.
- `SUPABASE_ANON_KEY`: clave pública anon del proyecto.
- `CRON_SECRET`: exactamente el mismo valor configurado como secreto en Supabase.

La tarea intenta cerrar eventos cada cinco minutos y se puede ejecutar manualmente desde **Actions**.

**La hora límite no depende de esta tarea programada.** El portal y la base de datos rechazan las modificaciones en cuanto `deadline_at` ya ha pasado. GitHub Actions revisa los cierres cada cinco minutos, por lo que la creación automática del snapshot oficial puede producirse unos minutos después del bloqueo. El panel de administración también procesa eventos vencidos al cargar el dashboard y permite cerrar manualmente un evento para generar la versión oficial en ese momento.

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
