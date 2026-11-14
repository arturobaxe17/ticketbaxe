-- Ejecuta este SQL en Supabase SQL Editor DESPUÉS de crear el usuario
-- administrador desde Authentication > Users.
-- Sustituye el correo por el email exacto de esa cuenta.

update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
where email = 'TU_CORREO_DE_ADMIN@ejemplo.com';

-- Comprueba que se haya actualizado una fila y que app_metadata incluya role=admin.
