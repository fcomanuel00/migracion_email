# 📧 Email Migrator – Node.js

App web local para migrar correos entre cuentas IMAP usando Node.js + Express.

---

## ⚙️ Requisitos

- Node.js 18 o superior
- npm

---

## 🚀 Instalación y arranque

```bash
# 1. Entrar a la carpeta
cd email_migrator_node

# 2. Instalar dependencias
npm install

# 3. Arrancar
npm start
```

Abre tu navegador en → **http://localhost:5050**

---

## 📋 Configuración de proveedores comunes

| Proveedor        | Host IMAP                  | Puerto | SSL |
|------------------|----------------------------|--------|-----|
| Gmail            | imap.gmail.com             | 993    | ✅  |
| Outlook/Hotmail  | imap-mail.outlook.com      | 993    | ✅  |
| Yahoo            | imap.mail.yahoo.com        | 993    | ✅  |
| cPanel / Plesk   | mail.tudominio.com         | 993    | ✅  |
| cPanel sin SSL   | mail.tudominio.com         | 143    | ❌  |

### ⚠️ Gmail: necesitas contraseña de aplicación

Google bloquea el login normal si tienes verificación en 2 pasos.
Ve a: **Cuenta Google → Seguridad → Contraseñas de aplicación** → genera una.

---

## 🔒 Seguridad

- La app corre solo en localhost, nadie externo puede acceder.
- Las contraseñas no se guardan en disco, solo se usan en memoria durante la migración.

---

## 🐛 Problemas comunes

| Error | Causa probable |
|-------|----------------|
| `Connection refused` | Host o puerto incorrectos |
| `Invalid credentials` | Usuario/contraseña mal escritos |
| `Mailbox does not exist` | El servidor destino tiene otro nombre de carpeta |
| Tarda mucho | Normal en buzones grandes, déjalo correr |
