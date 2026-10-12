# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Estatico dividido en archivos (`index.html` + `app.css` + `app.js`), sin compilacion ni instalacion, publicado en GitHub Pages desde `web/`.
Dependencias por CDN con version fijada (supabase-js 2.45.4; Leaflet 1.9.4 para el mapa). Sin framework por decision del usuario.

## Users
- **Supervisor de seguridad en sala de control**: monitor o TV grande, turno completo, vigila varios cascos y atiende alertas SOS / hombre caido / zonas de peligro.
- **Supervisor movil en campo**: celular o tablet, a la intemperie, una mano, sol; debe poder atender una alerta y ver el video en vivo.
- Ambos por igual: el mismo visor se adapta a monitor y a celular. Un administrador da de alta cascos, personas, grupos y zonas.
- El operario que usa el casco NO usa este visor (recibe avisos hablados en el casco).

## Product Purpose
Plataforma de mando para cascos inteligentes de seguridad industrial (oil & gas, mineria, construccion): recibe SOS por boton fisico, deteccion de
caida y de hombre caido, alarmas por geocercas y puntos de peligro, y muestra video y voz en vivo. El exito es que una alerta se vea, se atienda y
quede trazada (quien, cuando, con que nota) en el menor tiempo posible, y que el supervisor tenga el contexto (ubicacion, video, estado del equipo).

## Positioning
Plataforma local, en espanol rioplatense, con servidor y datos propios (sin nube china ni licencias de mapas chinos), video de baja latencia
(~80 ms al servidor desde San Pablo), atencion trazable de cada alerta y costo de infraestructura minimo (~USD 7,5 por mes).

## Operating Context
- Turnos largos frente a la pantalla; las alertas deben romper la atencion (sonido, color, contador) sin generar fatiga cuando no hay nada.
- Ruido, prisa y estres: una alerta se atiende en segundos; los errores cuestan seguridad.
- Cascos con 4G debil, sin la persona frente a una pantalla; el visor es el unico punto de control humano.
- Datos personales de trabajadores (ubicacion, DNI, telefono): acceso por rol, retencion acotada, aviso al personal (Ley 25.326).

## Capabilities and Constraints
- Alertas: SOS, caida, hombre caido (cuenta regresiva en el casco), geocerca/punto de peligro, equipo (bateria, sin senal). Atender con nota, historial.
- Video en vivo WebRTC con giro automatico/manual, pantalla completa, recorte de datos, grabacion a la PC con audio (nada en el servidor), captura.
- Voz en vivo con el casco (WebRTC audio), evacuacion y mensajes a cascos (texto a voz en espanol).
- Mapa con recorrido, zonas dibujables y puntos de interes; pestana Equipos (cascos, personas, grupos, asignaciones).
- Roles: `device` (casco), `viewer` (supervisor), `admin`. Seguridad por RLS en Supabase; el visor nunca usa claves secretas.
- Fuera de alcance por decision del usuario: gases, ATEX, signos vitales. Escalamiento por Teams: apagado.
- Sin compilacion; GitHub Pages; Supabase Realtime; sin Node en produccion.

## Brand Commitments
Nombre: "Casco Inteligente". Sin logo ni colores corporativos que respetar: se define una identidad nueva sobria y profesional.
Voz: espanol rioplatense, directo, sin jerga; frases cortas en alertas.

## Evidence on Hand
- Capturas y reportes de prueba en `out/` (web-*.png, *-report.md).
- Casco real 4132 en produccion de prueba; video, SOS, atender y pestanas verificados en vivo.
- No hay testimonios, clientes ni metricas comerciales: no inventarlos.

## Product Principles
1. **La alerta manda**: lo urgente interrumpe y se resuelve en un paso; lo demas espera.
2. **Claridad antes que decoracion**: estado y accion siempre visibles; nada de color solo como senal.
3. **Contexto en un vistazo**: quien, donde, desde cuando, con que bateria y senal.
4. **Confianza y trazabilidad**: cada accion deja registro; los datos sensibles se muestran solo a quien corresponde.
5. **Funciona en cualquier pantalla y en cualquier mano**: monitor de sala de control o celular a la intemperie.

## Accessibility & Inclusion
WCAG 2.2 AA como piso: contraste, foco visible, teclado completo, objetivos tactiles >= 44 px, no depender solo del color, `prefers-reduced-motion`,
lectores de pantalla (roles/live regions para alertas). Modo claro y oscuro. Lectura a pleno sol (alto contraste en claro).
