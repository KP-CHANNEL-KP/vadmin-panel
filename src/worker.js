// ========= KP VIP Worker (Admin Secret + 1DV) =========

// user list
async function listUsers(env) {
  const txt = await env.USERS_KV.get("users");
  return txt ? JSON.parse(txt) : [];
}

// save list
async function saveUsers(env, list) {
  await env.USERS_KV.put("users", JSON.stringify(list));
}

// JSON helper
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// ===== Admin auth =====
async function adminOnly(request, env, handler) {
  const ADMIN_SECRET = env.ADMIN_SECRET || "";
  const header = request.headers.get("x-admin-secret") || "";

  if (!ADMIN_SECRET || header !== ADMIN_SECRET) {
    return json({ status: "error", message: "Unauthorized" }, 401);
  }

  return handler(request, env);
}

// ===== create user (1DV) =====
// Panel က days ကို initialDays အနေနဲ့သိမ်းပြီး
// expireAt = null, firstLoginAt = null ထားမယ်
async function handleCreateUser(req, env) {
  const body = await req.formData();
  const username = (body.get("username") || "").trim();
  const password = (body.get("password") || "").trim();
  const days = parseInt(body.get("days"));

  if (!username || !password || !days) {
    return json({ status: "error", message: "invalid params" }, 400);
  }

  const users = await listUsers(env);
  if (users.find(u => u.username === username)) {
    return json({ status: "error", message: "User exists" }, 409);
  }

  const now = Math.floor(Date.now() / 1000);
  const initialDays = days;

  const user = {
    username,
    password,
    createdAt: now,
    initialDays,     // 1DV days
    firstLoginAt: null,
    expireAt: null   // login မဝင်သေးလို့ null
  };

  users.push(user);
  await saveUsers(env, users);

  return json({
    status: "ok",
    username,
    // panel မှာ သုံးမထားလို့ expireAt ကို null ပဲ ပြန်ပို့
    expireAt: user.expireAt
  });
}

// ===== renew/edit =====
// User က login မဝင်သေး (expireAt = null) ဆိုရင် initialDays ကိုပဲ +days
// login ဝင်ပြီးသားဆိုရင် expireAt ကို +days
async function handleEditUser(req, env) {
  const body = await req.formData();
  const username = (body.get("username") || "").trim();
  const days = parseInt(body.get("days"));

  if (!username || !days) {
    return json({ status: "error", message: "invalid" }, 400);
  }

  const users = await listUsers(env);
  const u = users.find(x => x.username === username);
  if (!u) {
    return json({ status: "error", message: "no user" }, 404);
  }

  const extraSeconds = days * 86400;

  if (!u.expireAt) {
    // first login မဝင်သေး -> days ကို စုထား
    u.initialDays = (u.initialDays || 0) + days;
  } else {
    // expire date ရှိပြီးသား -> expireAt ကို တိုက်ရိုက် +days
    u.expireAt += extraSeconds;
  }

  await saveUsers(env, users);
  return json({ status: "ok" });
}

// ===== delete =====
async function handleDeleteUser(req, env) {
  const body = await req.formData();
  const username = (body.get("username") || body.get("usernameToDelete") || "").trim();

  if (!username) {
    return json({ status: "error", message: "missing username" }, 400);
  }

  let users = await listUsers(env);
  const before = users.length;
  users = users.filter(u => u.username !== username);
  await saveUsers(env, users);

  return json({ status: "ok", deleted: before - users.length });
}

// ===== login for APP (1DV start here) =====
async function handleLogin(req, env) {
  const body = await req.formData();
  const username = (body.get("username") || "").trim();
  const password = (body.get("password") || "").trim();

  if (!username || !password) {
    return json({ status: "fail", message: "missing_params" });
  }

  const users = await listUsers(env);
  const u = users.find(x => x.username === username);

  if (!u) {
    return json({ status: "fail", message: "user_not_found" });
  }

  if (u.password !== password) {
    return json({ status: "fail", message: "wrong_password" });
  }

  const now = Math.floor(Date.now() / 1000);

  // 1DV logic: firstLoginAt မရှိသေးရင် ဒီနေရာမှာ စမှတ်
  if (!u.firstLoginAt) {
    u.firstLoginAt = now;
    const days = u.initialDays || 0;
    u.expireAt = now + days * 86400;
    await saveUsers(env, users);
  }

  if (!u.expireAt || now > u.expireAt) {
    return json({ status: "fail", message: "expired" });
  }

  const secondsLeft = u.expireAt - now;
  let daysLeft = Math.ceil(secondsLeft / 86400);
  if (daysLeft < 1) daysLeft = 1;

  // APK ထဲမှာ status == "login", user, expired_date အသုံးပြုထားလို့ ဒီ format ကိုထိန်းပေး
  return json({
    status: "login",
    user: username,
    expired_date: String(daysLeft)
  });
}

// ===== exist for APP =====
async function handleExist(req, env) {
  const body = await req.formData();
  const username = (body.get("username") || "").trim();

  if (!username) {
    return json({ status: "error", message: "missing_username" }, 400);
  }

  const users = await listUsers(env);
  const u = users.find(x => x.username === username);

  if (!u) {
    return json({ status: "fail", message: "user_not_found" });
  }

  const now = Math.floor(Date.now() / 1000);

  // first login မဝင်ရသေး (expireAt = null) ဆိုရင်
  // user_exist.php မှာတော့ "active" လိုသုံးချင်လား/ မသုံးချင်လား မင်းစိတ်ကြိုက် ပြင်လို့ရတယ်
  if (!u.expireAt) {
    return json({
      status: "success",
      user: username,
      expireAt: null,
      firstLoginAt: null
    });
  }

  if (now > u.expireAt) {
    return json({ status: "fail", message: "expired" });
  }

  return json({
    status: "success",
    user: username,
    expireAt: u.expireAt
  });
}

// ===== list for admin =====
async function handleList(req, env) {
  const users = await listUsers(env);
  return json({ status: "ok", users });
}

// ===== Router =====
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path.endsWith("create.php"))  return adminOnly(req, env, handleCreateUser);
    if (path.endsWith("edit.php"))    return adminOnly(req, env, handleEditUser);
    if (path.endsWith("delete.php"))  return adminOnly(req, env, handleDeleteUser);
    if (path.endsWith("list.php"))    return adminOnly(req, env, handleList);

    if (path.endsWith("login.php"))       return handleLogin(req, env);
    if (path.endsWith("user_exist.php"))  return handleExist(req, env);

    return json({ status: "error", message: "Not found", path, method: req.method }, 404);
  }
};
