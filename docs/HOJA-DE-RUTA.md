# Vigía · Casco Inteligente: que hace RundeCap y que debemos construir nosotros

Relevado del APK de RundeCap (constantes del protocolo, APIs, librerias) y del login real del casco 4132.
Objetivo: un casco competitivo a nivel local (industria, oil & gas, mineria, construccion) **sin depender de caps.runde.pro**.

## 1. Inventario de RundeCap
| Area | Funciones que trae |
|---|---|
| **Emergencia** | SOS boton fisico, "super SOS", SOS por llamada SIP, **SOS por caida** (`MSG_CAP_FALL`), SOS por altura (`sos_height`, barometro), casco **no puesto** (`MSG_CAP_NOT_WORN`), aviso de **proximidad a alta tension** (`nearvolt`, `MSG_PROXIMITY_REMINDER`) |
| **Comunicacion** | Llamada de audio y video con el supervisor (SIP/WebRTC), llamadas grupales de audio y video, mensajes de audio grupales, "pedir ayuda" (sala de ayuda), cambio de resolucion en vivo |
| **Video y foto** | Video en vivo (RTSP/WebRTC), foto remota (`TAKEPICTURE`), lista de videos locales, subida de video a pedido, grabacion local, respaldo offline |
| **Ubicacion** | GPS/AMap, reporte periodico, **geocercas** (personas dentro/fuera del perimetro), reproduccion de pista, balizas Bluetooth, UWB |
| **Gases** | CO, H2S, CH4, O2 (19,5-23,5 %), NH3, CO2, CH2O, SF6, NO, NO2, H2 con umbrales y alarma |
| **Salud** | Frecuencia cardiaca, oxigeno en sangre, presion, temperatura corporal (reloj), umbrales |
| **Gestion** | Tareas (`NEW_TASK`), grupos y personal, parametros de alarma remotos, reinicio/reset remoto, WiFi remoto, OTA, reporte de errores, prueba de red (iperf) |
| **Voz** | TTS y reconocimiento de voz (Baidu/iFlytek, en chino/ingles), mensajes de audio |
| **Hardware** | Linterna, PTT (DMR), 2 SIM, camara, parlante y microfono |

## 2. Donde estamos
| Funcion | RundeCap | Nuestra app |
|---|---|---|
| SOS boton fisico (F11) con aviso y **Atender** | si | **hecho** |
| Alerta por caida (caida libre + impacto) | si | **hecho** (umbrales a calibrar) |
| **Hombre caido** (caida + inmovilidad -> SOS automatico con cuenta regresiva) | si | **en construccion** |
| Video en vivo con login propio, baja latencia (~80 ms al servidor) | si | **hecho** |
| Auto-orientacion de la imagen, pantalla completa | no | **en construccion / hecho** |
| Estado de cascos (en linea, bateria) | si | **hecho** |
| Voz de avisos en espanol | no (ingles/chino) | **en construccion** |
| Llamada de voz bidireccional | si | **en construccion** |
| Foto y video a pedido desde el visor | si | falta |
| Ubicacion GPS + mapa | si (falla fuera de China) | falta |
| Geocercas | si | falta |
| Casco no puesto / inmovilidad prolongada | si | falta |
| Gases por Bluetooth | si | falta (requiere sensor) |
| Signos vitales | si | falta (requiere reloj) |
| Reportes e historial exportable | basico | falta |

## 3. Hoja de ruta propuesta (en orden de valor para el mercado local)
**Fase 1 - Seguridad de la persona (ya)**
1. SOS, **hombre caido**, video, voz bidireccional, avisos en espanol rioplatense.
2. Foto y video a pedido; mensaje del supervisor "texto a voz" en el casco (el supervisor escribe, el casco habla).

**Fase 2 - Contexto del incidente**
3. **Ubicacion GPS** en el evento y mapa (OpenStreetMap, sin AMap). Hoy el casco informa Shenzhen: es un fallo de licencia de AMap fuera de China que nuestro agente evita.
4. **Geocercas** (zona de trabajo / zona prohibida) con alerta de entrada y salida.
5. **Casco no puesto** (sensor de proximidad) y **inmovilidad prolongada**; bateria baja y perdida de senal.

**Fase 3 - Operacion y cumplimiento**
6. Reportes de incidentes (PDF/CSV) con linea de tiempo de atencion; exportacion a SharePoint/Teams (ISO 45001 / SGI).
7. Multi-casco y multi-sitio, roles (operador, supervisor, auditor), auditoria.
8. Cola offline en el casco (si no hay red, guarda y envia despues).

**Fase 4 - Sensores externos**
9. Gases por Bluetooth (O2, H2S, CO, LEL) y signos vitales con reloj. Requieren hardware y homologacion.

## 4. Diferenciales competitivos locales
- **Espanol rioplatense** de punta a punta (voz, textos, reportes).
- **Datos y servidor propios** (sin depender de una nube china ni de licencias de mapas chinos).
- **Atencion trazable**: quien atendio, cuando y con que nota; historial separado.
- **Costo**: servidor de ~USD 7,5/mes, sin licencia por casco.
- **Integracion Microsoft 365** (Teams, SharePoint, Power Automate), habitual en la industria local.
- **Latencia baja**: servidor en Sao Paulo (RTT ~80 ms) en vez de China (~420 ms).

## 5. Riesgos y limites
- Sin homologacion de seguridad intrinseca (ATEX) no se promete uso en atmosferas explosivas.
- El hombre caido depende de calibrar umbrales con pruebas reales (casco puesto, caminar, agacharse, golpe, caida).
- La voz bidireccional depende de la calidad del microfono y del parlante del casco y del ruido de planta.
