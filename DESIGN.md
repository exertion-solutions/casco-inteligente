# DESIGN — Casco Inteligente (visor web)

Direccion: **Plano de levantamiento**. Modo: operar. Contrato completo en `.impeccable/surfaces/web-index-html.md`.
El mundo aporta solo tipografia, paleta, densidad y un movimiento firma; navegacion y controles son los estandar de la web.

## Tipografia
- UI: Barlow Semi Condensed (400/600/700). Mono: IBM Plex Mono (ids, horas, contadores, coordenadas). Numeros tabulares.
- Escala fija: 12 / 14 / 16 / 20 / 28 / 44 px. Espaciado 4-8-12-16-24-32. Radio 6 px.

## Color (tokens en `web/app.css`, `:root`)
| Rol | Oscuro (sala de control) | Claro (pleno sol) |
|---|---|---|
| Fondo / superficie | #0e1a20 / #14242c | #edf1ef / #fbfdfc |
| Texto / apagado | #e8f0f2 / #8fa7b0 | #12232b / #4a5f68 |
| Acento (foco, seleccion) | #3cc3d8 | #006f85 |
| Pendiente / aviso | #ffb81c | #8a5a00 sobre #ffe9b0 |
| SOS / caida | #ff4d3d (fondo #d8301f) | #c4210f |
| OK | #3fcf8e | #0b7a46 |
Estado nunca solo por color: icono + texto. Tema por `prefers-color-scheme` + toggle persistido (`data-theme`).

## Estructura
- Header: marca, estado de conexion, hora ART, tema, usuario/salir.
- Navegacion: Centro / En vivo / Mapa / Equipos / Historial. Riel izquierdo >= 1024 px, tira 768-1023, barra inferior < 768 (objetivos >= 44 px, insignias de pendientes).
- Centro en 3 columnas (alertas | video | cascos, ordenes, eventos); movil en una columna.

## Movimiento firma: regla de estacion
Cada alerta pendiente lleva una regla horizontal con marcas por minuto; el cursor avanza con el tiempo transcurrido y la zona > 2 min se tine de la severidad. Se reutiliza en Historial ("Atendida a los mm:ss").

## Componentes y estados
- Tarjeta de alerta: icono + tipo + contador mono + borde grueso; accion primaria unica **Atender** (nota opcional), secundaria **Ver en vivo**.
- Banner de pendientes `aria-live="assertive"`; vacio ("Sin alertas pendientes"), cargando, error con Reintentar, sin senal.
- Foco 3 px acento, teclado completo (flechas cambian de pestana), `prefers-reduced-motion` respetado.

## Prohibido
Gradient text, glassmorphism, tarjetas anidadas, bordes laterales de color, neon, iconos decorativos.
