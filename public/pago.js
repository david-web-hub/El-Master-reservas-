/*
  PÁGINA DE PAGO (Cajita de Pagos de Payphone)
  - /pago.html?plan=<nombre>: pide al servidor un pago nuevo y muestra la Cajita.
  - /pago.html?resultado=<clientTransactionId>: resultado ya confirmado por el
    servidor (Payphone redirige a /pagos/payphone/respuesta, que confirma y
    trae aquí). Si la confirmación sigue en curso, se consulta de nuevo.
  El navegador nunca decide si un pago fue aprobado: solo muestra lo que
  confirmó el servidor con Payphone.
*/
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var parametros = new URLSearchParams(location.search);
  var dinero = function (v) { return '$' + Number(v).toFixed(2); };
  var fecha = function (v) {
    return v ? new Date(v).toLocaleDateString('es-EC', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  };

  function mostrar(id, visible) { $(id).classList.toggle('oculto', !visible); }
  function estado(texto, tipo) {
    var e = $('estado');
    e.className = 'aviso ' + (tipo || '');
    e.textContent = texto;
    mostrar('estado', Boolean(texto));
  }

  function pedir(url, opciones) {
    return fetch(url, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opciones || {}))
      .then(function (r) {
        if (r.status === 401) { location.href = '/acceso.html'; throw new Error('Inicia sesión para continuar'); }
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok || d.ok === false) throw new Error(d.error || 'No se pudo completar la operación');
          return d;
        });
      });
  }

  function cargarRecurso(etiqueta, atributos) {
    return new Promise(function (ok, mal) {
      var el = document.createElement(etiqueta);
      Object.keys(atributos).forEach(function (k) { el.setAttribute(k, atributos[k]); });
      el.onload = ok;
      el.onerror = function () { mal(new Error('No se pudo cargar el formulario de Payphone')); };
      document.head.appendChild(el);
    });
  }

  function esperarCajita(limite) {
    return new Promise(function (ok, mal) {
      var inicio = Date.now();
      (function revisar() {
        if (typeof window.PPaymentButtonBox === 'function') return ok(window.PPaymentButtonBox);
        if (Date.now() - inicio > limite) return mal(new Error('El formulario de Payphone no respondió'));
        setTimeout(revisar, 100);
      })();
    });
  }

  /* 1. Nuevo pago de un plan. */
  function iniciarPago(plan) {
    pedir('/api/admin/pagos', { method: 'POST', body: JSON.stringify({ plan: plan }) })
      .then(function (d) {
        $('titulo').textContent = 'Plan ' + d.payment.plan;
        $('precio').innerHTML = dinero(d.payment.amount) + ' <small>USD por un mes</small>';
        mostrar('precio', true);
        mostrar('modo', d.mode === 'pruebas');
        $('detalle').textContent = 'Si estás en tu prueba gratuita, el mes pagado empieza cuando termina la prueba. ' +
          'No se hace ningún cobro automático después: cada mes se paga desde aquí.';
        return cargarRecurso('link', { rel: 'stylesheet', href: d.scripts.css })
          .then(function () { return cargarRecurso('script', { type: 'module', src: d.scripts.js }); })
          .then(function () { return esperarCajita(10000); })
          .then(function (Cajita) { new Cajita(d.box).render('pp-button'); });
      })
      .catch(function (error) {
        $('titulo').textContent = 'No se pudo preparar el pago';
        estado(error.message, 'error');
      });
  }

  /* 2. Resultado confirmado por el servidor. */
  function mostrarResultado(id, intento) {
    pedir('/api/admin/pagos/' + encodeURIComponent(id))
      .then(function (d) {
        var p = d.payment;
        $('titulo').textContent = 'Plan ' + p.plan;
        $('precio').innerHTML = dinero(p.amount) + ' <small>USD</small>';
        mostrar('precio', true);
        mostrar('modo', p.mode === 'pruebas');
        if (p.status === 'approved' && p.activates === false) {
          estado('Pago de prueba aprobado. No se cobró dinero real y tu suscripción no cambia.', 'ok');
        } else if (p.status === 'approved') {
          estado('Pago aprobado. Tu plan ' + p.plan + ' está pagado hasta el ' + fecha(p.periodEnd) + '.', 'ok');
          if (p.card && p.card.lastDigits) $('detalle').textContent = (p.card.brand || 'Tarjeta') + ' terminada en ' + p.card.lastDigits;
        } else if (p.status === 'canceled') {
          estado('El pago no fue aprobado' + (p.message ? ': ' + p.message : '.') + ' No se hizo ningún cobro. Puedes intentarlo de nuevo.', 'error');
        } else if (p.status === 'review') {
          estado('Recibimos tu pago, pero necesitamos revisarlo antes de activar tu plan. Te escribiremos pronto.', 'error');
        } else if (intento < 24) {
          estado('Estamos confirmando tu pago con Payphone…', '');
          setTimeout(function () { mostrarResultado(id, intento + 1); }, 5000);
        } else {
          estado('Todavía no pudimos confirmar tu pago. Si se cobró, tu plan se activará en cuanto Payphone lo confirme.', 'error');
        }
      })
      .catch(function (error) {
        $('titulo').textContent = 'Resultado del pago';
        estado(error.message, 'error');
      });
  }

  if (parametros.get('resultado')) {
    mostrarResultado(parametros.get('resultado'), 0);
  } else if (parametros.get('plan')) {
    iniciarPago(parametros.get('plan'));
  } else {
    $('titulo').textContent = 'Pago de suscripción';
    estado(parametros.get('error') ? 'No se pudo procesar la respuesta del pago.' : 'Elige un plan desde Planes.', 'error');
  }
})();
