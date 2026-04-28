export class NoopConnectionStrategy {
    async resolve(currentClients, _options) {
        return { clients: currentClients, toolsChanged: false };
    }
}
//# sourceMappingURL=noop-connection-strategy.js.map