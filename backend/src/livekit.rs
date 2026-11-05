use crate::{model::ROOM, security::livekit_token};
use serde_json::{Value, json};
#[derive(Clone)]
pub struct LiveKit {
    pub endpoint: String,
    pub public_url: String,
    pub key: String,
    pub secret: String,
    pub client: reqwest::Client,
}
impl LiveKit {
    pub async fn rpc(&self, service: &str, method: &str, body: Value) -> anyhow::Result<Value> {
        let token = livekit_token(
            &self.key,
            &self.secret,
            "streamhive-api",
            "",
            json!({"roomAdmin":true,"roomCreate":true,"roomList":true,"roomRecord":true,"room":ROOM}),
        );
        let r = self
            .client
            .post(format!(
                "{}/twirp/livekit.{service}/{method}",
                self.endpoint
            ))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await?;
        anyhow::ensure!(
            r.status().is_success(),
            "LiveKit {service}/{method}: HTTP {}",
            r.status()
        );
        Ok(r.json().await?)
    }
    pub fn join_token(&self, identity: &str, name: &str) -> String {
        livekit_token(
            &self.key,
            &self.secret,
            identity,
            name,
            json!({"roomJoin":true,"room":ROOM,"canPublish":true,"canPublishData":false,"canSubscribe":true,"canUpdateOwnMetadata":false,"canPublishSources":["camera","microphone","screen_share","screen_share_audio"]}),
        )
    }
    /// Credencial del compositor local: oculto, solo suscribe (prefijo EG_ = exento de revocación).
    pub fn recorder_token_for(&self, format: crate::model::OutputFormat) -> String {
        livekit_token(
            &self.key,
            &self.secret,
            if format == crate::model::OutputFormat::Portrait {
                "EG_recorder_portrait"
            } else {
                "EG_recorder"
            },
            "Compositor",
            json!({"roomJoin":true,"room":ROOM,"canPublish":false,"canPublishData":false,"canSubscribe":true,"hidden":true}),
        )
    }
    pub async fn remove(&self, identity: &str) -> anyhow::Result<()> {
        self.rpc(
            "RoomService",
            "RemoveParticipant",
            json!({"room":ROOM,"identity":identity}),
        )
        .await?;
        Ok(())
    }
}
pub fn egress_request(path: &str, template: &str, destinations: &[String]) -> Value {
    json!({"room_name":ROOM,"template":{"custom_base_url":template,"layout":"streamhive"},"advanced":{"width":1920,"height":1080,"framerate":30,"video_codec":"H264_MAIN","video_bitrate":6000,"audio_codec":"AAC","audio_bitrate":160},"outputs":[{"file":{"file_type":"MP4","filepath":path,"disable_manifest":true}},{"stream":{"protocol":"RTMP","urls":destinations}}]})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_encode_has_file_and_stream_outputs() {
        let v = egress_request(
            "/recordings/id.mp4",
            "http://app/render",
            &["rtmps://x/k".to_string(), "rtmp://y/k".to_string()],
        );
        assert_eq!(v["outputs"].as_array().unwrap().len(), 2);
        assert_eq!(v["template"]["custom_base_url"], "http://app/render");
        assert!(v.get("file_outputs").is_none());
        // Varias plataformas: una sola salida de stream con todas las URL (una sola codificación).
        assert_eq!(
            v["outputs"][1]["stream"]["urls"].as_array().unwrap().len(),
            2
        );
    }
}
