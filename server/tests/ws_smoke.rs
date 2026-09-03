//! Optional WS smoke (ignored). Run with a server on 127.0.0.1:17777:
//! `cargo test --test ws_smoke -- --ignored --nocapture`

use futures_util::{SinkExt, StreamExt};
use multiplayer_server::protocol::{parse_envelope, Envelope};
use serde_json::json;
use tokio_tungstenite::connect_async;

async fn recv_type(
    stream: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    want: &str,
) -> Envelope {
    for _ in 0..20 {
        let msg = stream.next().await.expect("ws").expect("ok");
        let text = msg.to_text().expect("text");
        let env = parse_envelope(text).expect("parse");
        if env.msg_type == want {
            return env;
        }
    }
    panic!("did not receive {want}");
}

#[tokio::test]
#[ignore = "requires running server on 127.0.0.1:17777"]
async fn two_clients_join() {
    let url = "ws://127.0.0.1:17777/ws";
    let (a, _) = connect_async(url).await.unwrap();
    let (b, _) = connect_async(url).await.unwrap();
    let (mut a_w, mut a_r) = a.split();
    let (mut b_w, mut b_r) = b.split();

    let hello = |create: bool, code: &str| {
        serde_json::to_string(&Envelope::new(
            "HELLO",
            json!({"create": create, "roomCode": code, "displayName": ""}),
        ))
        .unwrap()
    };

    a_w.send(hello(true, "").into()).await.unwrap();
    let welcome = recv_type(&mut a_r, "WELCOME").await;
    let room = welcome.payload["roomCode"].as_str().unwrap().to_string();

    b_w.send(hello(false, &room).into()).await.unwrap();
    let _ = recv_type(&mut b_r, "WELCOME").await;
}
