/*
  MOSTRAR / OCULTAR CONTRASEÑA (ojito)
  - Añade un ojo a cada campo de contraseña de la página, también a los que se
    crean después (formularios del panel que se dibujan al abrir una sección).
  - Oculta por defecto. Un toque muestra lo escrito; otro lo vuelve a ocultar.
  - Solo muestra lo que la persona escribió o pegó en el campo: si el navegador
    rellenó una contraseña guardada, no se muestra hasta que el campo se vacía.
  - Antes de enviar un formulario, todos los campos vuelven a quedar ocultos.
  - No cambia la autenticación ni las validaciones: solo alterna el tipo del
    campo entre "password" y "text" en el navegador.
  - El control es un <span role="button"> y no un <button>, para no alterar los
    formularios que buscan su primer botón.
*/
(function () {
  'use strict';

  var OJO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var OJO_TACHADO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M2 2l20 20"/></svg>';
  var ESTILO =
    '.ojo-campo{position:relative;display:block}' +
    '.ojo-campo>input{padding-right:46px!important}' +
    '.ojo-boton{position:absolute;top:50%;right:4px;transform:translateY(-50%);width:40px;height:40px;' +
    'display:grid;place-items:center;border-radius:10px;cursor:pointer;color:#9da6af;' +
    '-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;touch-action:manipulation}' +
    '.ojo-boton:hover{color:#f4c94d}' +
    '.ojo-boton:focus-visible{outline:2px solid #d4af37;outline-offset:-2px}' +
    '.ojo-boton[aria-disabled="true"]{opacity:.45;cursor:not-allowed}';

  var contador = 0;

  function autorrellenado(campo) {
    try { if (campo.matches(':autofill')) return true; } catch (e) { /* navegador sin :autofill */ }
    try { if (campo.matches(':-webkit-autofill')) return true; } catch (e) { /* navegador sin :-webkit-autofill */ }
    return false;
  }

  /* Solo se puede mostrar lo que la persona escribió (no lo que rellenó el navegador). */
  function sePuedeMostrar(campo) {
    if (!campo.value) return true;
    return campo.dataset.ojoEscrito === '1' && !autorrellenado(campo);
  }

  function pintar(campo, boton) {
    var visible = campo.type === 'text';
    boton.innerHTML = visible ? OJO_TACHADO : OJO;
    boton.setAttribute('aria-label', visible ? 'Ocultar contraseña' : 'Mostrar contraseña');
    boton.setAttribute('title', visible ? 'Ocultar contraseña' : 'Mostrar contraseña');
    boton.setAttribute('aria-pressed', visible ? 'true' : 'false');
    boton.setAttribute('aria-disabled', !visible && !sePuedeMostrar(campo) ? 'true' : 'false');
  }

  function ocultar(campo) {
    if (campo.type !== 'text') return;
    campo.type = 'password';
    var boton = campo.parentNode && campo.parentNode.querySelector('.ojo-boton');
    if (boton) pintar(campo, boton);
  }

  function alternar(campo, boton) {
    if (campo.type === 'text') {
      campo.type = 'password';
    } else {
      if (!sePuedeMostrar(campo)) return;
      campo.type = 'text';
    }
    pintar(campo, boton);
  }

  function preparar(campo) {
    if (campo.dataset.ojo) return;
    campo.dataset.ojo = '1';
    if (!campo.id) campo.id = 'campo-contrasena-' + (++contador);

    var envoltura = document.createElement('span');
    envoltura.className = 'ojo-campo';
    campo.parentNode.insertBefore(envoltura, campo);
    envoltura.appendChild(campo);

    var boton = document.createElement('span');
    boton.className = 'ojo-boton';
    boton.setAttribute('role', 'button');
    boton.setAttribute('tabindex', '0');
    boton.setAttribute('aria-controls', campo.id);
    envoltura.appendChild(boton);

    /* Lo que escribe o pega la persona trae inputType; el autorrelleno del navegador no. */
    campo.addEventListener('input', function (e) {
      if (!campo.value) campo.dataset.ojoEscrito = '';
      else if (e.inputType && e.inputType !== 'insertReplacementText' && campo.dataset.ojoEscrito !== '0') campo.dataset.ojoEscrito = '1';
      else campo.dataset.ojoEscrito = '0';
      if (campo.dataset.ojoEscrito === '0') ocultar(campo);
      pintar(campo, boton);
    });
    /* Si el navegador rellenó el campo antes de que se escribiera nada, queda bloqueado hasta vaciarlo. */
    campo.addEventListener('focus', function () {
      if (campo.value && campo.dataset.ojoEscrito !== '1') campo.dataset.ojoEscrito = '0';
      pintar(campo, boton);
    });
    if (campo.value) campo.dataset.ojoEscrito = '0';

    /* Evita que el campo pierda el foco (y el teclado del celular se cierre) al tocar el ojo. */
    boton.addEventListener('mousedown', function (e) { e.preventDefault(); });
    boton.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      alternar(campo, boton);
    });
    boton.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        e.stopPropagation();
        alternar(campo, boton);
      }
    });

    pintar(campo, boton);
  }

  function revisar(raiz) {
    var campos = (raiz || document).querySelectorAll('input[type="password"]:not([data-ojo])');
    for (var i = 0; i < campos.length; i++) preparar(campos[i]);
  }

  function iniciar() {
    var estilo = document.createElement('style');
    estilo.textContent = ESTILO;
    document.head.appendChild(estilo);
    revisar(document);
    new MutationObserver(function () { revisar(document); })
      .observe(document.body, { childList: true, subtree: true });
    /* Al enviar cualquier formulario, las contraseñas vuelven a quedar ocultas. */
    document.addEventListener('submit', function (e) {
      var visibles = e.target.querySelectorAll ? e.target.querySelectorAll('input[data-ojo][type="text"]') : [];
      for (var i = 0; i < visibles.length; i++) ocultar(visibles[i]);
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
