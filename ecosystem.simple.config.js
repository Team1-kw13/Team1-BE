module.exports = {
    apps: [
        {
            name: "sonju-api",
            script: "./index.js",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "1G",

            // 크래시 후 재시작 설정
            restart_delay: 3000, // 재시작 전 3초 대기
            max_restarts: 5, // 최대 재시작 횟수 (시간당)
            min_uptime: "10s", // 최소 실행 시간

            // WebSocket 서버 특화 설정
            kill_timeout: 5000,
            listen_timeout: 8000,

            // 무시할 파일들
            ignore_watch: [
                "node_modules",
                "logs",
                "*.log",
                "test-*.js",
                "public",
            ],
        },
    ],
};
