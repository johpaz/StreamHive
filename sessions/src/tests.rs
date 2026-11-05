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
        c.execute_batch("PRAGMA user_version=2")?;
        Ok(())
    })
    .await
    .unwrap();
    assert!(App::open(s.config.clone()).is_err());
}
