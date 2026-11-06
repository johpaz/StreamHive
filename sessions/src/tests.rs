use super::*;
use http_body_util::BodyExt;
use tower::ServiceExt;
fn app() -> App {
    let p = std::env::temp_dir()
        .join(format!("sh-sessions-test-{}", id()))
        .join("sessions.sqlite");
    App::open(Config::new("http://localhost:8080", p).unwrap()).unwrap()
}
async fn call(
    s: &App,
    method: &str,
    path: &str,
    token: Option<&str>,
    cookie_value: Option<&str>,
    body: Value,
) -> (StatusCode, HeaderMap, Value) {
    let mut r = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(t) = token {
        r = r.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    if let Some(t) = cookie_value {
        r = r.header(header::COOKIE, t);
    }
    let response = router(s.clone())
        .oneshot(r.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, headers, json)
}
async fn install(s: &App) -> String {
    call(s, "POST", "/api/v1/installations", None, None, json!({}))
        .await
        .2["credential"]
        .as_str()
        .unwrap()
        .into()
}
async fn room(s: &App, t: &str) -> String {
    call(
        s,
        "POST",
        "/api/v1/sessions/current",
        Some(t),
        None,
        json!({}),
    )
    .await
    .2["session"]["id"]
        .as_str()
        .unwrap()
        .into()
}
async fn invite(s: &App, t: &str, sid: &str) -> Value {
    call(
        s,
        "POST",
        &format!("/api/v1/sessions/{sid}/invitations"),
        Some(t),
        None,
        json!({}),
    )
    .await
    .2
}
async fn join_guest(s: &App, i: &Value, name: &str) -> (String, Value) {
    let token = i["url"].as_str().unwrap().rsplit('/').next().unwrap();
    let (code, h, b) = call(
        s,
        "POST",
        &format!("/api/v1/join/{token}"),
        None,
        None,
        json!({"name":name}),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    (
        h[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .into(),
        b,
    )
}
#[test]
fn public_url_is_https_except_loopback() {
    for u in [
        "http://example.com",
        "https://user:pass@example.com",
        "https://example.com/path",
        "https://example.com?key=s",
    ] {
        assert!(Config::new(u, PathBuf::from("/tmp/a.sqlite")).is_err());
    }
    assert!(
        Config::new(
            "https://sessions.example.com",
            PathBuf::from("/tmp/a.sqlite")
        )
        .is_ok()
    );
}
#[tokio::test]
async fn installations_are_isolated_and_credentials_are_not_in_snapshots() {
    let s = app();
    let a = install(&s).await;
    let b = install(&s).await;
    let sid = room(&s, &a).await;
    let i = invite(&s, &a, &sid).await;
    assert_eq!(
        call(
            &s,
            "GET",
            &format!("/api/v1/sessions/{sid}"),
            Some(&b),
            None,
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &s,
            "POST",
            &format!("/api/v1/sessions/{sid}/invitations"),
            Some(&b),
            None,
            json!({})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &s,
            "DELETE",
            &format!("/api/v1/invitations/{}", i["id"].as_str().unwrap()),
            Some(&b),
            None,
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &s,
            "GET",
            &format!("/api/v1/sessions/{sid}"),
            None,
            None,
            Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let snapshot = call(
        &s,
        "GET",
        &format!("/api/v1/sessions/{sid}"),
        Some(&a),
        None,
        Value::Null,
    )
    .await
    .2
    .to_string();
    assert!(!snapshot.contains(&a));
    assert!(!snapshot.contains(i["url"].as_str().unwrap()));
    let raw = s
        .db(|c| {
            Ok(c.query_row(
                "SELECT credential_hash FROM installations LIMIT 1",
                [],
                |r| r.get::<_, String>(0),
            )?)
        })
        .await
        .unwrap();
    assert_ne!(raw, a);
    assert_ne!(raw, b);
}
#[tokio::test]
async fn admission_rejection_removal_and_close_are_scoped_and_persistent() {
    let s = app();
    let t = install(&s).await;
    let sid = room(&s, &t).await;
    let i = invite(&s, &t, &sid).await;
    let (cookie, g) = join_guest(&s, &i, "Invitado").await;
    let pid = g["participant_id"].as_str().unwrap();
    let path = format!("/api/v1/sessions/{sid}/participants/{pid}");
    assert_eq!(
        call(&s, "GET", "/api/v1/guest", None, Some(&cookie), Value::Null)
            .await
            .2["participant"]["status"],
        "waiting"
    );
    assert_eq!(
        call(
            &s,
            "POST",
            &path,
            None,
            Some(&cookie),
            json!({"action":"admit"})
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    for _ in 0..2 {
        assert_eq!(
            call(&s, "POST", &path, Some(&t), None, json!({"action":"admit"}))
                .await
                .0,
            StatusCode::OK
        );
    }
    let restored = App::open(s.config.clone()).unwrap();
    let state = call(
        &restored,
        "GET",
        "/api/v1/guest",
        None,
        Some(&cookie),
        Value::Null,
    )
    .await
    .2;
    assert_eq!(state["participant"]["status"], "admitted");
    assert_eq!(state["session"]["host_online"], false);
    assert!(state.get("participants").is_none());
    assert_eq!(
        call(
            &s,
            "POST",
            &path,
            Some(&t),
            None,
            json!({"action":"remove"})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&s, "GET", "/api/v1/guest", None, Some(&cookie), Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&s, "POST", &path, Some(&t), None, json!({"action":"admit"}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let i = invite(&s, &t, &sid).await;
    let (cookie, g) = join_guest(&s, &i, "Rechazado").await;
    let pid = g["participant_id"].as_str().unwrap();
    assert_eq!(
        call(
            &s,
            "POST",
            &format!("/api/v1/sessions/{sid}/participants/{pid}"),
            Some(&t),
            None,
            json!({"action":"reject"})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&s, "GET", "/api/v1/guest", None, Some(&cookie), Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    for _ in 0..2 {
        assert_eq!(
            call(
                &s,
                "POST",
                &format!("/api/v1/sessions/{sid}/close"),
                Some(&t),
                None,
                json!({})
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        call(
            &s,
            "GET",
            "/api/v1/sessions/current",
            Some(&t),
            None,
            Value::Null
        )
        .await
        .2["session"],
        Value::Null
    );
}
#[tokio::test]
async fn revoked_and_expired_invites_cannot_join() {
    let s = app();
    let t = install(&s).await;
    let sid = room(&s, &t).await;
    let i = invite(&s, &t, &sid).await;
    let (cookie, _) = join_guest(&s, &i, "Guest").await;
    call(
        &s,
        "DELETE",
        &format!("/api/v1/invitations/{}", i["id"].as_str().unwrap()),
        Some(&t),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(
        call(&s, "GET", "/api/v1/guest", None, Some(&cookie), Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let token = i["url"].as_str().unwrap().rsplit('/').next().unwrap();
    assert_eq!(
        call(
            &s,
            "POST",
            &format!("/api/v1/join/{token}"),
            None,
            None,
            json!({"name":"x"})
        )
        .await
        .0,
        StatusCode::GONE
    );
    let i = invite(&s, &t, &sid).await;
    s.db(|c| {
        c.execute("UPDATE invitations SET expires=0", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let token = i["url"].as_str().unwrap().rsplit('/').next().unwrap();
    assert_eq!(
        call(
            &s,
            "POST",
            &format!("/api/v1/join/{token}"),
            None,
            None,
            json!({"name":"x"})
        )
        .await
        .0,
        StatusCode::GONE
    );
}
#[tokio::test]
async fn waiting_room_is_bounded_and_session_creation_is_idempotent() {
    let s = app();
    let t = install(&s).await;
    let sid = room(&s, &t).await;
    let i = invite(&s, &t, &sid).await;
    for _ in 0..20 {
        join_guest(&s, &i, "Guest").await;
    }
    let token = i["url"].as_str().unwrap().rsplit('/').next().unwrap();
    assert_eq!(
        call(
            &s,
            "POST",
            &format!("/api/v1/join/{token}"),
            None,
            None,
            json!({"name":"x"})
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    let mut tasks = Vec::new();
    for _ in 0..20 {
        let s = s.clone();
        let t = t.clone();
        tasks.push(tokio::spawn(async move { room(&s, &t).await }));
    }
    for task in tasks {
        assert_eq!(task.await.unwrap(), sid);
    }
}
#[tokio::test]
async fn origin_limits_and_api_fallback_are_enforced() {
    let mut s = app();
    s.config.registrations_per_hour = 1;
    install(&s).await;
    assert_eq!(
        call(&s, "POST", "/api/v1/installations", None, None, json!({}))
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    let r = Request::builder()
        .method("POST")
        .uri("/api/v1/installations")
        .header(header::ORIGIN, "https://evil.example")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        router(s.clone()).oneshot(r).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&s, "GET", "/api/v1/not-real", None, None, Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn a_newer_database_is_never_silently_downgraded() {
    let s = app();
    s.db(|c| {
        c.execute_batch("PRAGMA user_version=4")?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(App::open(s.config.clone()).is_err());
}

#[tokio::test]
async fn chat_requires_admission_is_scoped_and_recovers_moderation() {
    let s = app();
    let owner = install(&s).await;
    let sid = room(&s, &owner).await;
    let i = invite(&s, &owner, &sid).await;
    let (cookie, g) = join_guest(&s, &i, "Ana 🐝").await;
    let pid = g["participant_id"].as_str().unwrap();
    let path = format!("/api/v1/chat/messages?session_id={sid}");
    // En sala de espera ya se lee y se escribe, para coordinar el ingreso.
    assert_eq!(
        call(&s, "GET", &path, None, Some(&cookie), Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    let early = call(
        &s,
        "POST",
        "/api/v1/chat/messages",
        None,
        Some(&cookie),
        json!({"session_id":sid,"client_message_id":id(),"text":"Estoy lista"}),
    )
    .await;
    assert_eq!(early.0, StatusCode::OK);
    assert_eq!(early.2["sender_role"], "waiting");
    let payload = json!({"session_id":sid,"client_message_id":id(),"text":"Hola 🐝"});
    call(
        &s,
        "POST",
        &format!("/api/v1/sessions/{sid}/participants/{pid}"),
        Some(&owner),
        None,
        json!({"action":"admit"}),
    )
    .await;
    let sent = call(
        &s,
        "POST",
        "/api/v1/chat/messages",
        None,
        Some(&cookie),
        payload.clone(),
    )
    .await;
    assert_eq!(sent.0, StatusCode::OK);
    assert_eq!(sent.2["sender_name"], "Ana 🐝");
    assert_eq!(
        call(
            &s,
            "POST",
            "/api/v1/chat/messages",
            None,
            Some(&cookie),
            payload
        )
        .await
        .2["id"],
        sent.2["id"]
    );
    let restored = App::open(s.config.clone()).unwrap();
    let page = call(&restored, "GET", &path, Some(&owner), None, Value::Null)
        .await
        .2;
    assert_eq!(page["messages"].as_array().unwrap().len(), 2);
    let (rejected_cookie, rejected) = join_guest(&s, &i, "Luis").await;
    let rejected_id = rejected["participant_id"].as_str().unwrap();
    call(
        &s,
        "POST",
        &format!("/api/v1/sessions/{sid}/participants/{rejected_id}"),
        Some(&owner),
        None,
        json!({"action":"reject"}),
    )
    .await;
    assert_eq!(
        call(&s, "GET", &path, None, Some(&rejected_cookie), Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let delete = format!(
        "/api/v1/chat/messages/{}?session_id={sid}",
        sent.2["id"].as_str().unwrap()
    );
    assert_eq!(
        call(&s, "DELETE", &delete, None, Some(&cookie), Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&s, "DELETE", &delete, Some(&owner), None, Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    let recovery = call(
        &s,
        "GET",
        &format!("{path}&after={}", page["cursor"]),
        None,
        Some(&cookie),
        Value::Null,
    )
    .await
    .2;
    assert_eq!(recovery["events"][0]["message"]["deleted"], true);
    let other = install(&s).await;
    let other_sid = room(&s, &other).await;
    assert_ne!(other_sid, sid);
    assert_eq!(
        call(&s, "GET", &path, Some(&other), None, Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &s,
            "GET",
            &format!("/api/v1/chat/messages?session_id={other_sid}"),
            None,
            Some(&cookie),
            Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    call(
        &s,
        "POST",
        &format!("/api/v1/sessions/{sid}/participants/{pid}"),
        Some(&owner),
        None,
        json!({"action":"remove"}),
    )
    .await;
    assert_eq!(
        call(&s, "GET", &path, None, Some(&cookie), Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    call(
        &s,
        "POST",
        &format!("/api/v1/sessions/{sid}/close"),
        Some(&owner),
        None,
        json!({}),
    )
    .await;
    assert_eq!(
        call(&s, "GET", &path, Some(&owner), None, Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

async fn raw(
    s: &App,
    method: &str,
    path: &str,
    token: Option<&str>,
    cookie_value: Option<&str>,
    name: &str,
    body: Vec<u8>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut r = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            "x-file-name",
            base64::engine::general_purpose::STANDARD.encode(name),
        );
    if let Some(t) = token {
        r = r.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    if let Some(t) = cookie_value {
        r = r.header(header::COOKIE, t);
    }
    let response = router(s.clone())
        .oneshot(r.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, bytes.to_vec())
}

#[tokio::test]
async fn chat_files_reach_waiting_guests_and_never_rejected_ones() {
    let s = app();
    let owner = install(&s).await;
    let sid = room(&s, &owner).await;
    let i = invite(&s, &owner, &sid).await;
    let (cookie, _) = join_guest(&s, &i, "Ana").await;
    let files = format!("/api/v1/chat/files?session_id={sid}");
    // Más grande que el límite general de 16 KB de las peticiones JSON.
    let mut pdf = b"%PDF-1.7\n".to_vec();
    pdf.resize(300_000, b'x');
    let up = raw(
        &s,
        "POST",
        &files,
        None,
        Some(&cookie),
        "Guion.pdf",
        pdf.clone(),
    )
    .await;
    assert_eq!(up.0, StatusCode::OK, "{}", String::from_utf8_lossy(&up.2));
    let fid = serde_json::from_slice::<Value>(&up.2).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let sent = call(
        &s,
        "POST",
        "/api/v1/chat/messages",
        None,
        Some(&cookie),
        json!({"session_id":sid,"client_message_id":id(),"text":"","attachment_id":fid}),
    )
    .await;
    assert_eq!(sent.0, StatusCode::OK, "{}", sent.2);
    assert_eq!(sent.2["sender_role"], "waiting");
    assert_eq!(sent.2["attachment"]["name"], "Guion.pdf");
    let path = format!("/api/v1/chat/files/{fid}?session_id={sid}");
    let got = raw(&s, "GET", &path, Some(&owner), None, "x", vec![]).await;
    assert_eq!(got.0, StatusCode::OK);
    assert_eq!(got.2, pdf);
    assert!(
        got.1[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .starts_with("attachment;")
    );
    assert_eq!(got.1[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(
        raw(
            &s,
            "POST",
            &files,
            None,
            Some(&cookie),
            "x.pdf",
            b"MZ".to_vec()
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    // Otra sesión no ve el archivo.
    let other = room(&s, &install(&s).await).await;
    assert_eq!(
        raw(
            &s,
            "GET",
            &format!("/api/v1/chat/files/{fid}?session_id={other}"),
            None,
            Some(&cookie),
            "x",
            vec![]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    // Rechazada: sin acceso.
    let (rejected, r) = join_guest(&s, &i, "Luis").await;
    call(
        &s,
        "POST",
        &format!(
            "/api/v1/sessions/{sid}/participants/{}",
            r["participant_id"].as_str().unwrap()
        ),
        Some(&owner),
        None,
        json!({"action":"reject"}),
    )
    .await;
    assert_eq!(
        raw(&s, "GET", &path, None, Some(&rejected), "x", vec![])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    // El anfitrión borra el mensaje y el archivo deja de existir, también en disco.
    let mid = sent.2["id"].as_str().unwrap();
    call(
        &s,
        "DELETE",
        &format!("/api/v1/chat/messages/{mid}?session_id={sid}"),
        Some(&owner),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(
        raw(&s, "GET", &path, Some(&owner), None, "x", vec![])
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn the_hosts_stage_reaches_admitted_guests_only() {
    let s = app();
    let t = install(&s).await;
    let sid = room(&s, &t).await;
    let i = invite(&s, &t, &sid).await;
    let (cookie, guest) = join_guest(&s, &i, "Ana").await;
    let pid = guest["participant_id"].as_str().unwrap().to_owned();
    let stage = json!({"program":{"layout":"grid","identities":[format!("g-{pid}")]},"names":{"host":"Eva"},"live":true});
    let path = format!("/api/v1/sessions/{sid}/stage");
    // Only the owner publishes, with a bounded object.
    let other = install(&s).await;
    assert_eq!(
        call(&s, "PUT", &path, Some(&other), None, stage.clone())
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&s, "PUT", &path, None, Some(&cookie), stage.clone())
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&s, "PUT", &path, Some(&t), None, json!([1])).await.0,
        StatusCode::BAD_REQUEST
    );
    let big = json!({"x":"a".repeat(STAGE_LIMIT)});
    assert_ne!(
        call(&s, "PUT", &path, Some(&t), None, big).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(&s, "PUT", &path, Some(&t), None, stage.clone())
            .await
            .0,
        StatusCode::OK
    );
    let guest_state = |s: App, cookie: String| async move {
        call(&s, "GET", "/api/v1/guest", None, Some(&cookie), Value::Null)
            .await
            .2
    };
    // Waiting: nothing of the stage yet.
    assert!(
        guest_state(s.clone(), cookie.clone())
            .await
            .get("stage")
            .is_none()
    );
    let decide = format!("/api/v1/sessions/{sid}/participants/{pid}");
    call(
        &s,
        "POST",
        &decide,
        Some(&t),
        None,
        json!({"action":"admit"}),
    )
    .await;
    assert_eq!(guest_state(s.clone(), cookie.clone()).await["stage"], stage);
    // The host's own snapshot never carries it, and closing the session drops it.
    assert!(
        call(
            &s,
            "GET",
            &format!("/api/v1/sessions/{sid}"),
            Some(&t),
            None,
            Value::Null
        )
        .await
        .2
        .get("stage")
        .is_none()
    );
    call(
        &s,
        "POST",
        &format!("/api/v1/sessions/{sid}/close"),
        Some(&t),
        None,
        json!({}),
    )
    .await;
    assert!(s.stages.lock().unwrap().get(&sid).is_none());
}
#[tokio::test]
async fn cleaning_the_guest_list_keeps_who_is_in_and_can_empty_everything() {
    let s = app();
    let t = install(&s).await;
    let sid = room(&s, &t).await;
    let path = format!("/api/v1/sessions/{sid}/cleanup");
    let session = |s: App, t: String, sid: String| async move {
        call(
            &s,
            "GET",
            &format!("/api/v1/sessions/{sid}"),
            Some(&t),
            None,
            Value::Null,
        )
        .await
        .2
    };
    let decide = |pid: &Value, action: &str| {
        let (s, t, sid, pid, action) = (
            s.clone(),
            t.clone(),
            sid.clone(),
            pid.as_str().unwrap().to_owned(),
            action.to_owned(),
        );
        async move {
            call(
                &s,
                "POST",
                &format!("/api/v1/sessions/{sid}/participants/{pid}"),
                Some(&t),
                None,
                json!({"action":action}),
            )
            .await
            .0
        }
    };
    let i = invite(&s, &t, &sid).await;
    let dead = invite(&s, &t, &sid).await;
    let (in_cookie, inside) = join_guest(&s, &i, "Ana").await;
    let (_, waiting) = join_guest(&s, &i, "Luis").await;
    let (_, rejected) = join_guest(&s, &i, "Eva").await;
    let (out_cookie, removed) = join_guest(&s, &i, "Raúl").await;
    assert_eq!(
        decide(&inside["participant_id"], "admit").await,
        StatusCode::OK
    );
    assert_eq!(
        decide(&removed["participant_id"], "admit").await,
        StatusCode::OK
    );
    assert_eq!(
        decide(&removed["participant_id"], "remove").await,
        StatusCode::OK
    );
    assert_eq!(
        decide(&rejected["participant_id"], "reject").await,
        StatusCode::OK
    );
    call(
        &s,
        "DELETE",
        &format!("/api/v1/invitations/{}", dead["id"].as_str().unwrap()),
        Some(&t),
        None,
        Value::Null,
    )
    .await;
    // Only the owner cleans, with a known scope.
    let other = install(&s).await;
    assert_eq!(
        call(
            &s,
            "POST",
            &path,
            Some(&other),
            None,
            json!({"scope":"all"})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &s,
            "POST",
            &path,
            None,
            Some(&in_cookie),
            json!({"scope":"all"})
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&s, "POST", &path, Some(&t), None, json!({"scope":"todo"}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    // Finished: rejected, removed and dead links go; who is in or waiting stays.
    assert_eq!(
        call(
            &s,
            "POST",
            &path,
            Some(&t),
            None,
            json!({"scope":"finished"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let snap = session(s.clone(), t.clone(), sid.clone()).await;
    let mut names: Vec<_> = snap["participants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["Ana", "Luis"]);
    let links: Vec<_> = snap["invitations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].clone())
        .collect();
    assert_eq!(links, [i["id"].clone()]);
    assert_eq!(
        call(
            &s,
            "GET",
            "/api/v1/guest",
            None,
            Some(&out_cookie),
            Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    // All: nobody left, every link revoked and gone, the stage dropped, nobody gets back in.
    call(
        &s,
        "PUT",
        &format!("/api/v1/sessions/{sid}/stage"),
        Some(&t),
        None,
        json!({"live":true}),
    )
    .await;
    assert_eq!(
        call(&s, "POST", &path, Some(&t), None, json!({"scope":"all"}))
            .await
            .0,
        StatusCode::OK
    );
    let snap = session(s.clone(), t.clone(), sid.clone()).await;
    assert_eq!(snap["participants"], json!([]));
    assert_eq!(snap["invitations"], json!([]));
    assert_eq!(snap["session"]["closed"], false);
    assert!(s.stages.lock().unwrap().get(&sid).is_none());
    assert_eq!(
        call(
            &s,
            "GET",
            "/api/v1/guest",
            None,
            Some(&in_cookie),
            Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let token = i["url"].as_str().unwrap().rsplit('/').next().unwrap();
    assert_eq!(
        call(
            &s,
            "POST",
            &format!("/api/v1/join/{token}"),
            None,
            None,
            json!({"name":"Ana"})
        )
        .await
        .0,
        StatusCode::GONE
    );
    // The session goes on: a new link for the new day works.
    let fresh = invite(&s, &t, &sid).await;
    join_guest(&s, &fresh, "Nuevo").await;
    assert_eq!(
        call(&s, "GET", "/api/v1/meta", None, None, Value::Null)
            .await
            .2["features"],
        json!(["cleanup"])
    );
}
#[tokio::test]
async fn camera_effects_are_served_from_the_allowlist_with_their_csp() {
    let dir = std::env::temp_dir().join(format!("sh-assets-{}", id()));
    std::fs::create_dir_all(dir.join("effects")).unwrap();
    std::fs::create_dir_all(dir.join("backgrounds")).unwrap();
    std::fs::write(dir.join("effects/loader.mjs"), "export {}").unwrap();
    std::fs::write(dir.join("backgrounds/office-warm.webp"), b"RIFF").unwrap();
    std::fs::write(dir.join("effects/secret.txt"), "no").unwrap();
    let raw = |s: App, path: &'static str| async move {
        router(s)
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap()
    };
    // Without the folder, nothing is served.
    let bare = app();
    assert_eq!(
        raw(bare.clone(), "/effects/loader.mjs").await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&bare, "GET", "/api/v1/meta", None, None, Value::Null)
            .await
            .2["effects"],
        false
    );
    let p = std::env::temp_dir()
        .join(format!("sh-sessions-test-{}", id()))
        .join("sessions.sqlite");
    let mut config = Config::new("http://localhost:8080", p).unwrap();
    config.assets = Some(dir);
    let s = App::open(config).unwrap();
    assert_eq!(
        call(&s, "GET", "/api/v1/meta", None, None, Value::Null)
            .await
            .2["effects"],
        true
    );
    let r = raw(s.clone(), "/effects/loader.mjs").await;
    assert_eq!(r.status(), StatusCode::OK);
    assert!(
        r.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/javascript")
    );
    assert_eq!(r.headers()[header::CACHE_CONTROL], "public, max-age=86400");
    assert_eq!(
        raw(s.clone(), "/backgrounds/office-warm.webp")
            .await
            .headers()[header::CONTENT_TYPE],
        "image/webp"
    );
    // Only the allowlist: no other files, no way out of the folder.
    for path in [
        "/effects/secret.txt",
        "/effects/../effects/loader.mjs",
        "/effects/%2e%2e/secret.txt",
        "/backgrounds/x.webp",
    ] {
        assert_eq!(
            raw(s.clone(), path).await.status(),
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
    // The page's import map is allowed by its hash, WASM can run, and API answers stay uncached.
    let page = raw(s.clone(), "/join/abc").await;
    let csp = page.headers()[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap()
        .to_owned();
    let map = INDEX
        .split_once(r#"<script type="importmap">"#)
        .unwrap()
        .1
        .split_once("</script>")
        .unwrap()
        .0;
    let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(map.as_bytes()));
    assert!(
        csp.contains(&format!("'sha256-{hash}'")) && csp.contains("'wasm-unsafe-eval'"),
        "{csp}"
    );
    assert!(!csp.contains("unsafe-inline"));
    assert_eq!(
        raw(s.clone(), "/api/v1/meta").await.headers()[header::CACHE_CONTROL],
        "no-store"
    );
}
