const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");

const options = {
    definition: {
        openapi: "3.0.0",
        info: {
            title: "어르신 민원 도우미 API",
            version: "1.0.0",
            description: "음성 기반 민원 지원 시스템의 백엔드 API 문서",
        },
    },
    apis: ["./routes/*.js"], // 라우터 주석 위치
};

const specs = swaggerJsdoc(options);

module.exports = {
    swaggerUi,
    specs,
};
