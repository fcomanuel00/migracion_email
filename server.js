const express      = require('express');
const { ImapFlow } = require('imapflow');
const path         = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let sseClients      = [];
let migracionActiva = false;

const LOTE = 100;

function log(msg) {
  console.log(msg);
  sseClients.forEach(res => res.write(`data: ${msg}\n\n`));
}

function crearCliente(cfg) {
  return new ImapFlow({
    host:   cfg.host,
    port:   parseInt(cfg.port),
    secure: cfg.ssl,
    auth:   { user: cfg.user, pass: cfg.password },
    tls:    { rejectUnauthorized: false },
    logger: false,
  });
}

async function conectar(cfg) {
  const cliente = crearCliente(cfg);
  await cliente.connect();
  return cliente;
}

async function cerrar(cliente) {
  try { await cliente.logout(); } catch (_) {}
}

// ── NAMESPACE ──────────────────────────────────────────────
// Los servidores IMAP pueden tener distintos prefijos y separadores.
// Ejemplos:
//   IONOS:  prefijo="" separador="/"  → carpetas: "Enviados", "INBOX"
//   cPanel: prefijo="" separador="."  → carpetas: "INBOX", "INBOX.Enviados"
//   o bien: prefijo="INBOX/" sep="/"
//
// Necesitamos saber cómo organiza cada servidor para traducir
// los nombres de carpeta de origen a destino correctamente.

async function obtenerNamespace(cliente) {
  try {
    const ns = await cliente.listNamespaces();
    const personal = ns?.personal?.[0];
    return {
      prefix:    personal?.prefix    ?? '',
      delimiter: personal?.delimiter ?? '/',
    };
  } catch (_) {
    return { prefix: '', delimiter: '/' };
  }
}

/**
 * Traduce el nombre de una carpeta del espacio de nombres origen
 * al espacio de nombres destino.
 *
 * Ejemplo:
 *   origen:  prefix=""        sep="/"  → nombre="Elementos enviados"
 *   destino: prefix="INBOX/"  sep="/"  → resultado="INBOX/Elementos enviados"
 *
 * Ejemplo 2:
 *   origen:  prefix=""   sep="/"  → nombre="INBOX/Subcarpeta"
 *   destino: prefix=""   sep="."  → resultado="INBOX.Subcarpeta"
 */
function traducirCarpeta(nombre, srcNs, dstNs) {
  // 1. Quitar el prefijo del origen si lo tiene
  let sinPrefijo = nombre;
  if (srcNs.prefix && nombre.startsWith(srcNs.prefix)) {
    sinPrefijo = nombre.slice(srcNs.prefix.length);
  }

  // 2. Convertir el separador de origen al de destino
  //    (por si origen usa "/" y destino usa ".")
  if (srcNs.delimiter !== dstNs.delimiter) {
    sinPrefijo = sinPrefijo.split(srcNs.delimiter).join(dstNs.delimiter);
  }

  // 3. Sin añadir prefijo del destino: las carpetas quedan en raíz, igual que en origen.
  return sinPrefijo;
}

// ── MIGRACIÓN ──────────────────────────────────────────────

async function migrar(srcCfg, dstCfg) {
  migracionActiva = true;

  try {
    log('🔌 Conectando a cuenta ORIGEN...');
    let src = await conectar(srcCfg);
    log(`✅ Origen conectado: ${srcCfg.user}`);

    log('🔌 Conectando a cuenta DESTINO...');
    let dst = await conectar(dstCfg);
    log(`✅ Destino conectado: ${dstCfg.user}`);

    // Detectar namespaces de ambos servidores
    const srcNs = await obtenerNamespace(src);
    const dstNs = await obtenerNamespace(dst);
    log(`📐 Namespace origen:  prefijo="${srcNs.prefix}" sep="${srcNs.delimiter}"`);
    log(`📐 Namespace destino: prefijo="${dstNs.prefix}" sep="${dstNs.delimiter}"`);

    log('📂 Obteniendo carpetas del origen...');
    const carpetas = await src.list();
    log(`📋 ${carpetas.length} carpeta(s): ${carpetas.map(c => c.path).join(', ')}`);

    let totalMigrados = 0;

    for (const carpeta of carpetas) {
      const nombreSrc = carpeta.path;
      // Traducir el nombre al espacio de nombres del destino
      const nombreDst = traducirCarpeta(nombreSrc, srcNs, dstNs);

      log(`\n📁 [${nombreSrc}] → [${nombreDst}]`);

      let mailbox;
      try {
        mailbox = await src.mailboxOpen(nombreSrc, { readOnly: true });
      } catch (e) {
        log(`  ⚠️  No se pudo abrir [${nombreSrc}]: ${e.message}`);
        continue;
      }

      const total = mailbox.exists;
      if (total === 0) {
        log(`  📭 Carpeta vacía, saltando.`);
        await src.mailboxClose();
        continue;
      }

      log(`  📨 ${total} mensajes encontrados.`);

      // Crear carpeta en destino con el nombre traducido
      try {
        await dst.mailboxCreate(nombreDst);
        log(`  ➕ Carpeta [${nombreDst}] creada en destino.`);
      } catch (_) { /* ya existe */ }

      await src.mailboxClose();

      // Procesar en lotes reconectando entre cada uno
      for (let inicio = 1; inicio <= total; inicio += LOTE) {
        const fin   = Math.min(inicio + LOTE - 1, total);
        const rango = `${inicio}:${fin}`;

        await cerrar(src);
        await cerrar(dst);
        src = await conectar(srcCfg);
        dst = await conectar(dstCfg);

        try {
          await src.mailboxOpen(nombreSrc, { readOnly: true });

          for await (const msg of src.fetch(rango, {
            uid:          true,
            flags:        true,
            internalDate: true,
            source:       true,
          })) {
            try {
              // Usamos nombreDst para subir al lugar correcto en destino
              await dst.append(nombreDst, msg.source, [...msg.flags], msg.internalDate);
              totalMigrados++;
            } catch (e) {
              log(`  ❌ Error UID ${msg.uid}: ${e.message}`);
            }
          }

          await src.mailboxClose();
          log(`  ✉️  [${nombreSrc}] ${Math.min(fin, total)}/${total} migrados...`);

        } catch (e) {
          log(`  ⚠️  Error en lote ${rango}: ${e.message}. Reintentando...`);

          await cerrar(src);
          await cerrar(dst);
          src = await conectar(srcCfg);
          dst = await conectar(dstCfg);

          try {
            await src.mailboxOpen(nombreSrc, { readOnly: true });
            for await (const msg of src.fetch(rango, {
              uid: true, flags: true, internalDate: true, source: true,
            })) {
              try {
                await dst.append(nombreDst, msg.source, [...msg.flags], msg.internalDate);
                totalMigrados++;
              } catch (e2) {
                log(`  ❌ Reintento fallido UID ${msg.uid}: ${e2.message}`);
              }
            }
            await src.mailboxClose();
            log(`  ✉️  [${nombreSrc}] ${Math.min(fin, total)}/${total} migrados (reintento ok)`);
          } catch (e2) {
            log(`  💥 Lote ${rango} fallido definitivamente: ${e2.message}`);
          }
        }
      }
    }

    log(`\n🎉 MIGRACIÓN COMPLETADA — ${totalMigrados} mensajes migrados.`);
    await cerrar(src);
    await cerrar(dst);

  } catch (e) {
    log(`\n💥 ERROR FATAL: ${e.message}`);
  } finally {
    migracionActiva = false;
    log('__FIN__');
  }
}

// ── RUTAS ──────────────────────────────────────────────────

app.post('/migrate', (req, res) => {
  if (migracionActiva) return res.json({ ok: false, error: 'Migración en curso.' });
  const d = req.body;
  migrar(
    { host: d.src_host, port: d.src_port, user: d.src_user, password: d.src_pass, ssl: d.src_ssl },
    { host: d.dst_host, port: d.dst_port, user: d.dst_user, password: d.dst_pass, ssl: d.dst_ssl }
  );
  res.json({ ok: true });
});

app.get('/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  const hb = setInterval(() => res.write(': heartbeat\n\n'), 20000);
  req.on('close', () => {
    clearInterval(hb);
    sseClients = sseClients.filter(c => c !== res);
  });
});

app.listen(5050, () => console.log('\n🚀 Email Migrator → http://localhost:5050\n'));