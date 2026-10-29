// Punto de entrada de los contratos. Cada paquete proto se expone como un
// namespace porque varios paquetes declaran mensajes con el mismo nombre (por
// ejemplo HandleAuctionClosedRequest). El codigo de `generated/` lo produce
// `npm run generate` y no se edita a mano.
export * as commonV1 from './generated/artauction/common/v1/common';
export * as identityV1 from './generated/artauction/identity/v1/identity';
export * as catalogV1 from './generated/artauction/catalog/v1/catalog';
export * as catalogHandlersV1 from './generated/artauction/catalog/v1/handlers';
export * as catalogEventsV1 from './generated/artauction/catalog/events/v1/events';
export * as auctionV1 from './generated/artauction/auction/v1/auction';
export * as auctionHandlersV1 from './generated/artauction/auction/v1/handlers';
export * as auctionEventsV1 from './generated/artauction/auction/events/v1/events';
export * as walletV1 from './generated/artauction/wallet/v1/wallet';
export * as walletHandlersV1 from './generated/artauction/wallet/v1/handlers';
export * as auditV1 from './generated/artauction/audit/v1/audit';
export * as auditHandlersV1 from './generated/artauction/audit/v1/handlers';
export * as auditEventsV1 from './generated/artauction/audit/events/v1/events';
export * as aiV1 from './generated/artauction/ai/v1/ai';
export * as galleryV1 from './generated/artauction/gallery/v1/gallery';
export * as galleryHandlersV1 from './generated/artauction/gallery/v1/handlers';
export * as notificationV1 from './generated/artauction/notification/v1/notification';
export * as notificationHandlersV1 from './generated/artauction/notification/v1/handlers';
