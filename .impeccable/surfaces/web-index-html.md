---
version: 1
slug: "web-index-html"
primary_target: "web/index.html"
related_targets: []
---

# Surface brief: visor Casco Inteligente (web/index.html + app.css + app.js)

Mode: operate. Users: sala de control (monitor grande) y supervisor movil (una mano, sol). Ambos por igual.

## Direction contract: "Plano de levantamiento" (survey sheet)
World lends ONLY: type, palette, density, one signature move. Layout/nav/controls stay standard web.

- Type: Barlow Semi Condensed (UI, titulos, numeros grandes) + IBM Plex Mono (ids, horas, coordenadas, contadores). Escala fija 12/14/16/20/28/44. Numeros tabulares.
- Palette dark (default sala de control): ground #0e1a20 (tinta azul-verdosa), surface #14242c, line #24404b, text #e8f0f2, muted #8fa7b0, accent survey-cyan #3cc3d8 (seleccion, foco, enlace), pendiente = amarillo hi-vis #ffb81c, SOS/caida = rojo senal #ff4d3d, ok = verde #3fcf8e. Light (pleno sol): papel #f5f2ea, surface #fffdf8, tinta #12232b, accent #006f85, pendiente #8a5a00 sobre #ffe9b0, SOS #c4210f, ok #0b7a46. Contraste AA minimo; estado siempre con icono + texto, nunca solo color.
- Density: sala de control = 2-3 columnas (lista alertas | video | mapa/equipos); movil = una columna con barra inferior de pestanas. Objetivos >= 44 px.
- Signature move: "regla de estacion": cada alerta lleva una regla horizontal con marcas por minuto desde el inicio; el punto de inicio marcado, el tiempo transcurrido avanza como un cursor y la zona > 2 min se tiñe del color de severidad. Reusa la misma regla en el historial (duracion hasta Atender).
- Shell: header (marca, estado de conexion, reloj Argentina, tema claro/oscuro, usuario) ; nav = pestanas Centro / En vivo / Mapa / Equipos / Historial (rail izquierdo >= 1024 px, barra inferior < 768 px). Estados: cargando (skeleton), vacio ("Sin alertas pendientes. Todo en orden."), error con reintento, sin senal.
- Alert behavior: tarjeta SOS/caida rompe atencion (borde grueso + icono + contador + sonido ya existente), accion primaria unica "Atender" (nota opcional), secundaria "Ver en vivo". Aviso en region aria-live=assertive.
- A11y: WCAG 2.2 AA, foco visible 3 px accent, teclado completo, prefers-reduced-motion, prefers-color-scheme + toggle persistente, lang=es-AR.
- Preserve: toda la logica, ids, config.js, flujos (login, SOS/Atender, video WebRTC, giro, grabar, mapa, Equipos, evacuacion/mensaje). Solo cambia presentacion y estructura de archivos.
- Out: gradient text, glassmorphism, tarjetas anidadas, side-stripe borders, neon, iconos decorativos.
