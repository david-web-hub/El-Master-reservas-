# Pagos de suscripción con Payphone (Paso 1: modo de pruebas)

**Estado:** el código está listo y probado contra un Payphone simulado. **No hay cobros reales.** Los pagos están desactivados mientras no se configuren las variables de abajo.

## Cómo funciona

1. **El propietario elige un plan.** En **Planes**, pulsa «Pagar con tarjeta». La página `/pago.html` pide al servidor un pago nuevo (`POST /api/admin/pagos`).
2. **El servidor crea el pago.** Lo guarda como `pending`, con un `clientTransactionId` único y el monto del plan en centavos: Individual 1099, Pro 1999, Business 3499. La página muestra la **Cajita de Pagos** oficial de Payphone.
3. **Payphone cobra.** Pide los datos de la tarjeta en su formulario seguro; MF Plux no los ve. Después redirige a la URL de respuesta: `/pagos/payphone/respuesta?id=…&clientTransactionId=…`.
4. **El servidor confirma con Payphone** (API Confirm), dentro del plazo de 5 minutos que exige Payphone. El pago solo queda **aprobado** si:
   - el `statusCode` es 3;
   - el `clientTransactionId` y el `id` son los mismos;
   - el monto y la moneda coinciden.

   Si no se cumple todo, queda **rechazado** (`canceled`) o **en revisión** (`review`). El navegador nunca decide el resultado.
5. **Un pago aprobado amplía el período pagado del negocio.** En la misma transacción avisa al Panel Maestro con el evento `payment.approved`.

## Prueba gratuita y períodos

- **Prueba gratuita:** son los 7 días del catálogo, sin tarjeta y sin ningún cobro. La prueba se crea al registrarse y no se repite.
- **Pagar durante la prueba:** el mes pagado empieza cuando termina la prueba; no se pierden días.
- **Renovar:** el mes nuevo empieza al final del período pagado.
- **Cambiar de plan:** con un período pagado vigente no se puede pagar otro plan (respuesta `CAMBIO_EN_PERIODO`), para no perder días pagados. El cambio se solicita como hasta ahora.
- **Límite de profesionales:** no se puede pagar un plan que permita menos profesionales activos de los que ya tiene el negocio.
- **Barbería principal:** está protegida y nunca paga.

## El Panel Maestro sigue siendo la autoridad

- **Antes de que el Panel lo registre:** Reservas aplica el pago de forma **provisional**. El negocio queda activo, con el plan pagado, hasta `paid_through`. Es provisional mientras `paid_seq` sea mayor que `payments_acknowledged_seq`. La versión de la suscripción del Panel no cambia.
- **Cuando el Panel lo registra:** en su sincronización recibe el pago, activa el plan pagado y amplía el período, todo con una **versión nueva**. Al enviarla incluye `paymentsAppliedSeq`. Desde ese momento vuelve a mandar solo el Panel.
- **Suspensiones:** una suspensión decidida en el Panel siempre prevalece, aunque haya un pago provisional.
- **Ingresos:** los pagos de modo de pruebas nunca cuentan como ingresos reales en el Panel (`GET /api/admin/pagos` del Panel).

## Protección contra duplicados

- **Confirmar varias veces:** repetir la confirmación (recargar, volver atrás, varias peticiones a la vez) no aplica el pago dos veces. El pago se bloquea en la base y el identificador de Payphone es único.
- **Varios formularios:** si hay un pago ya enviado a Payphone y aún sin confirmar, no se abre otro (`PAGO_EN_PROCESO`). Los formularios abiertos y sin pagar quedan reemplazados (`superseded`).
- **Identificador distinto:** si llega otro id de Payphone para el mismo pago, se rechaza y queda en la bitácora.

## Errores y diagnóstico

- **Payphone no responde:** el pago sigue pendiente y una tarea revisa cada 30 segundos, durante 30 minutos, hasta confirmarlo. Pasado ese tiempo queda en `error` para revisarlo a mano.
- **Formularios abandonados:** se marcan `expired` a los 15 minutos. Si aun así llega la respuesta de Payphone, se confirma.
- **Bitácora:** `subscription_payment_log` guarda cada paso de cada pago, sin datos de la tarjeta. Los errores también salen en los registros del servidor (`PAGOS [error] …`).

## Datos que se guardan

| Se guarda | No se guarda |
|---|---|
| Marca y tipo de tarjeta, y como máximo 4 últimos dígitos (Payphone ya los devuelve así) | Número de tarjeta, CVV, BIN |
| Código de autorización e id de la transacción de Payphone | Correo, teléfono, documento y nombre del titular |
| Plan, monto, moneda, período, estado y modo | Token de Payphone (solo en variables de entorno) |

## Variables de entorno

| Variable | Valor |
|---|---|
| `PAGOS_PAYPHONE` | `pruebas` o `produccion`. Sin ella, los pagos están **desactivados**. |
| `PAYPHONE_TOKEN` | Token de la aplicación WEB en Payphone Developer. |
| `PAYPHONE_STORE_ID` | StoreID de la misma aplicación. |
| `PAGOS_REALES_AUTORIZADOS` | `si`. Obligatoria junto con `PAGOS_PAYPHONE=produccion`; sin ella no se activa nada. |

`PAYPHONE_CONFIRM_URL`, `PAYPHONE_CAJITA_JS` y `PAYPHONE_CAJITA_CSS` solo sirven para las pruebas automáticas. En producción (Render) se ignoran y se usan siempre las direcciones oficiales de Payphone.

> **Importante:** el ambiente lo decide la aplicación creada en Payphone Developer, no la variable `PAGOS_PAYPHONE`. Mientras `PAGOS_PAYPHONE=pruebas`, usa **solo** el Token y el StoreID de una aplicación configurada en ambiente de **PRUEBAS**.

## Para habilitar los pagos (no hecho; requiere tu autorización)

1. **Cuenta en Payphone:**
   1. Obtener el RUC.
   2. Crear la cuenta Payphone Business.
   3. Crear un usuario con rol **Desarrollador**.
2. **Aplicación en Payphone Developer:** crear una aplicación tipo **WEB**, en ambiente de **PRUEBAS**, con:
   - **Dominio web:** el de la aplicación, por ejemplo el valor de `PUBLIC_BASE_URL`. La Cajita solo funciona en ese dominio.
   - **URL de respuesta:** `<PUBLIC_BASE_URL>/pagos/payphone/respuesta`.
3. **Variables en Render:** configurar `PAGOS_PAYPHONE=pruebas`, `PAYPHONE_TOKEN` y `PAYPHONE_STORE_ID`. Desplegar y probar pagos de prueba: en ese ambiente todas las transacciones se aprueban y no hay cobros.
4. **Paso a producción:** cuando todo esté revisado y autorizado:
   1. pasar la aplicación de Payphone a PRODUCCIÓN;
   2. usar sus credenciales;
   3. configurar `PAGOS_PAYPHONE=produccion` y `PAGOS_REALES_AUTORIZADOS=si`.

## Lo que falta (siguientes pasos)

- **Renovación automática:**
  - requiere que Payphone apruebe la **tokenización**;
  - requiere RUC y la Cajita ya en producción;
  - Payphone retiene el 10 % de lo cobrado así durante 6 meses.

  Hasta entonces, cada mes se paga desde Planes.
- **Avisos y vencimientos:**
  - avisos por correo antes de que venza el período;
  - paso a «pago pendiente» y «vencida» según las reglas que decida el Panel.
- **Panel Maestro:** pantalla de pagos e ingresos reales en lugar de los datos de ejemplo. El Panel ya recibe y guarda los pagos, y los expone en `GET /api/admin/pagos`.
- **Notificación Externa (webhook) de Payphone:** opcional; requiere su autorización.
- **Reversos desde la API:** Payphone solo los permite el mismo día. Por ahora se hacen desde Payphone Business.
- **Facturación electrónica (SRI) e IVA:** se emitirán con el RUC. Los montos se envían hoy como `amountWithoutTax`; puede que haya que separar el IVA según cómo se facture.
