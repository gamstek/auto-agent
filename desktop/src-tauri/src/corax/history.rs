//! Native finite history reads. Admission and selected-view ownership stay in the host.
use super::{chat_debug, Connection};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

const TAIL_BYTE_LIMIT: usize = 2 * 1024 * 1024;
const MAX_TAIL_EVENTS: usize = 2048;
const MAX_CURSOR: u64 = 9_007_199_254_740_991;

#[derive(Debug, PartialEq)]
pub(super) enum HistoryQuery {
    From { start: usize, generation: Option<String> },
    Tail { count: usize },
}

impl HistoryQuery {
    pub(super) fn parse(path: &str) -> Result<Self, String> {
        let Some((_, query)) = path.split_once('?') else {
            return Ok(Self::From { start: 0, generation: None });
        };
        if let Some(count) = query.strip_prefix("tail=") {
            let count = parse_cursor(count)?;
            return if (1..=MAX_TAIL_EVENTS).contains(&count) {
                Ok(Self::Tail { count })
            } else { Err("最近历史事件数超出范围".into()) };
        }
        let (mut start, mut generation) = (None, None);
        for part in query.split('&') {
            let (key, value) = part.split_once('=').ok_or("事件游标无效")?;
            match key {
                "startIndex" if start.is_none() => start = Some(parse_cursor(value)?),
                "generation" if generation.is_none() && uuid::Uuid::parse_str(value).is_ok() => {
                    generation = Some(value.to_owned());
                }
                _ => return Err("事件游标无效".into()),
            }
        }
        Ok(Self::From { start: start.unwrap_or(0), generation })
    }
}

fn parse_cursor(value: &str) -> Result<usize, String> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("事件游标无效".into());
    }
    let value = value.parse::<u64>().ok().filter(|value| *value <= MAX_CURSOR).ok_or("事件游标无效")?;
    usize::try_from(value).map_err(|_| "事件游标无效".into())
}

#[derive(Debug)]
pub(super) struct HistoryPage {
    pub(super) start: usize,
    pub(super) revision: usize,
    pub(super) events: Vec<Value>,
    tail: bool,
}

impl HistoryPage {
    pub(super) fn authoritative(&self) -> bool {
        !self.tail || (self.start == 0 && self.revision == self.events.len()
            && (self.events.is_empty() || self.events[0]["type"] == "session.started"))
    }

    pub(super) fn into_response(self, session: &str, generation: &str, admitted: bool) -> Value {
        let complete = self.authoritative();
        let mut response = json!({"sessionId":session,"generation":generation,"startIndex":self.start,
            "revision":self.revision,"admitted":admitted,"events":self.events});
        if self.tail {
            response["complete"] = json!(complete);
            response["preview"] = json!(!complete);
        }
        response
    }
}

/// Retain parsed events and at most one unfinished NDJSON record, not a full body string.
#[derive(Default)]
struct HistoryDecoder {
    pending: Vec<u8>,
    events: Vec<Value>,
    bytes: usize,
}

impl HistoryDecoder {
    fn push(&mut self, bytes: &[u8], byte_limit: Option<usize>) -> Result<(), String> {
        self.bytes = self.bytes.checked_add(bytes.len()).ok_or("历史响应长度无效")?;
        if byte_limit.is_some_and(|limit| self.bytes > limit) {
            return Err("最近历史超出预览预算".into());
        }
        for part in bytes.split_inclusive(|byte| *byte == b'\n') {
            if self.pending.is_empty() && part.ends_with(b"\n") {
                Self::parse_line(part, &mut self.events)?;
            } else {
                self.pending.extend_from_slice(part);
                if part.ends_with(b"\n") {
                    Self::parse_line(&self.pending, &mut self.events)?;
                    self.pending.clear();
                }
            }
        }
        Ok(())
    }

    fn parse_line(line: &[u8], events: &mut Vec<Value>) -> Result<(), String> {
        let text = std::str::from_utf8(line).map_err(|_| "Corax 历史编码无效")?;
        if text.trim().is_empty() { return Ok(()); }
        let event: Value = serde_json::from_str(text).map_err(|_| "Corax 事件格式无效")?;
        if !event["type"].is_string() { return Err("Corax 事件缺少类型".into()); }
        events.push(event);
        Ok(())
    }

    fn finish(mut self) -> Result<Vec<Value>, String> {
        Self::parse_line(&self.pending, &mut self.events)?;
        Ok(self.events)
    }
}

pub(super) async fn read(client: &Client, backend: &Connection, id: &str, query: HistoryQuery) -> Result<HistoryPage, String> {
    let timing = chat_debug::Span::new("history-http");
    let (start, count) = match query {
        HistoryQuery::From { start, generation } => {
            (if generation.as_deref() == Some(&backend.generation) { start } else { 0 }, None)
        }
        HistoryQuery::Tail { count } => (0, Some(count)),
    };
    let index = count.map_or_else(|| start.to_string(), |count| format!("-{count}"));
    let tail_header = if count.is_some() { "&includeTailIndex=1" } else { "" };
    let url = format!("{}/corax/v1/session/{id}/stream?startIndex={index}&follow=false{tail_header}", backend.url);
    timing.mark("cursor", json!({"cursor":start}));
    let attempts = if count.is_some() { 1 } else { 25 };
    for attempt in 0..attempts {
        let mut response = client.get(&url).basic_auth("auto-agent", Some(&backend.token))
            .send().await.map_err(|_| "无法读取 Corax 会话状态")?;
        timing.mark("headers", json!({"attempt":attempt,"status":response.status().as_u16()}));
        if !response.status().is_success() {
            if attempt + 1 == attempts || ![404, 409, 425, 503].contains(&response.status().as_u16()) { break; }
            drop(response);
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        }
        let tail_revision = if count.is_some() {
            let tail = response.headers().get("x-corax-stream-tail-index")
                .and_then(|value| value.to_str().ok()).and_then(|value| value.parse::<i64>().ok())
                .filter(|value| (-1..MAX_CURSOR as i64).contains(value)).ok_or("最近历史缺少游标")?;
            Some(usize::try_from(tail + 1).map_err(|_| "最近历史游标无效")?)
        } else { None };
        let mut decoder = HistoryDecoder::default();
        while let Some(chunk) = response.chunk().await.map_err(|_| "Corax 会话记录读取中断")? {
            decoder.push(&chunk, count.map(|_| TAIL_BYTE_LIMIT))?;
        }
        timing.mark("body", json!({"bytes":decoder.bytes}));
        let events = decoder.finish()?;
        let revision = match tail_revision {
            Some(revision) if events.len() == count.unwrap().min(revision) => revision,
            Some(_) => return Err("最近历史游标不一致".into()),
            None => start.checked_add(events.len()).filter(|value| *value as u64 <= MAX_CURSOR).ok_or("历史事件游标溢出")?,
        };
        timing.mark("parsed", json!({"success":true,"count":events.len()}));
        return Ok(HistoryPage { start: if count.is_some() { revision - events.len() } else { start }, revision, events, tail: count.is_some() });
    }
    Err("Corax 会话记录暂不可读".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_rejects_mixed_or_unsafe_cursors() {
        for query in ["tail=0", "tail=2049", "tail=-1", "tail=1&startIndex=0", "tail=1&tail=2", "startIndex=-1", "startIndex=1&startIndex=2", "startIndex=9007199254740992", "generation=invalid", "url=private"] {
            assert!(HistoryQuery::parse(&format!("/events?{query}")).is_err(), "{query}");
        }
        assert_eq!(HistoryQuery::parse("/events?tail=512").unwrap(), HistoryQuery::Tail { count: 512 });
    }

    #[test]
    fn ndjson_handles_every_utf8_split_crlf_and_unterminated_final_record() {
        let body = "\r\n{\"type\":\"message.completed\",\"data\":{\"message\":\"完整中文\"}}\r\n \n{\"type\":\"turn.completed\"}";
        for width in 1..=body.len() {
            let mut decoder = HistoryDecoder::default();
            for chunk in body.as_bytes().chunks(width) { decoder.push(chunk, None).unwrap(); }
            let events = decoder.finish().unwrap();
            assert_eq!(events.len(), 2);
            assert_eq!(events[0]["data"]["message"], "完整中文");
        }
    }

    #[test]
    fn decoder_rejects_malformed_records_and_never_returns_a_truncated_preview() {
        for body in [b"{broken}\n".as_slice(), b"{}\n", b"\xff\n"] {
            assert!(HistoryDecoder::default().push(body, None).is_err());
        }
        let mut decoder = HistoryDecoder::default();
        decoder.push(b"{\"type\":\"turn.completed\"}\n", Some(30)).unwrap();
        assert!(decoder.push(b"          ", Some(30)).unwrap_err().contains("预算"));
        let mut incomplete = HistoryDecoder::default();
        incomplete.push(b"{\"type\":", None).unwrap();
        assert!(incomplete.finish().is_err());
    }

    #[test]
    fn decoder_releases_completed_line_buffer() {
        let body = b"{\"type\":\"turn.completed\"}\n".repeat(10000);
        let mut decoder = HistoryDecoder::default();
        decoder.push(&body, None).unwrap();
        assert!(decoder.pending.is_empty());
        assert_eq!(decoder.pending.capacity(), 0);
        assert_eq!(decoder.finish().unwrap().len(), 10000);
    }

    #[test]
    fn only_complete_tail_prefixes_are_authoritative() {
        let page = |start, revision, events| HistoryPage { start, revision, events, tail: true };
        assert!(page(0, 0, vec![]).authoritative());
        assert!(page(0, 1, vec![json!({"type":"session.started"})]).authoritative());
        assert!(!page(4, 5, vec![json!({"type":"session.started"})]).authoritative());
        assert!(!page(0, 1, vec![json!({"type":"message.completed"})]).authoritative());
    }
}
