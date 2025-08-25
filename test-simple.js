const WebSocket = require('ws');

// 간단한 WebSocket 연결 테스트
async function simpleTest() {
    console.log('[TEST] WebSocket 연결 시작...');
    
    const ws = new WebSocket('ws://localhost:3000');
    let connected = false;
    
    ws.on('open', () => {
        console.log('[TEST] WebSocket 연결 성공');
        connected = true;
        
        // 2초 대기 후 테스트 메시지 전송
        setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
                console.log('[TEST] preprompt 메시지 전송 시작');
                
                const message = {
                    channel: "openai:conversation",
                    type: "preprompted", 
                    enum: "동사무소"
                };
                
                console.log('[TEST] 전송 메시지:', JSON.stringify(message, null, 2));
                ws.send(JSON.stringify(message));
                
            } else {
                console.log('[TEST] WebSocket이 열려있지 않음:', ws.readyState);
            }
        }, 2000);
        
        // 8초 후 종료
        setTimeout(() => {
            console.log('[TEST] 테스트 완료, 연결 종료');
            ws.close();
        }, 8000);
    });
    
    ws.on('message', (data, isBinary) => {
        // 바이너리 데이터 필터링 (오디오 스트림)
        if (isBinary) {
            console.log('[TEST] 바이너리 데이터 수신 (오디오):', data.length, 'bytes');
            return;
        }
        
        try {
            const parsed = JSON.parse(data.toString());
            
            // 오디오 관련 메시지 필터링
            if (parsed.type && parsed.type.includes('audio')) {
                console.log('[TEST] 오디오 메시지:', parsed.type);
                return;
            }
            
            console.log('[TEST] 서버 응답:', {
                type: parsed.type,
                status: parsed.status,
                channel: parsed.channel,
                message: typeof parsed.message === 'string' ? parsed.message.substring(0, 150) + '...' : parsed.message,
                error: parsed.error
            });
        } catch (e) {
            const dataStr = data.toString();
            // JSON이 아닌 텍스트만 표시 (바이너리는 제외)
            if (dataStr.length > 0 && !dataStr.includes('\x00')) {
                console.log('[TEST] 파싱 불가한 텍스트:', dataStr.substring(0, 100) + '...');
            }
        }
    });
    
    ws.on('error', (error) => {
        console.error('[TEST] WebSocket 오류:', error.message);
        console.error('[TEST] 스택:', error.stack);
    });
    
    ws.on('close', (code, reason) => {
        console.log('[TEST] 연결 종료:', { 
            code, 
            reason: reason?.toString(),
            wasConnected: connected 
        });
        process.exit(connected ? 0 : 1);
    });
    
    // 타임아웃 설정 (15초)
    setTimeout(() => {
        if (!connected) {
            console.error('[TEST] 연결 타임아웃');
            ws.terminate();
            process.exit(1);
        }
    }, 15000);
}

console.log('=== 간단 WebSocket 테스트 ===');
console.log('서버가 localhost:3000에서 실행 중인지 확인하세요.\n');

simpleTest().catch(console.error);