// Test transport: serialize real public RPC requests; never substitute RPC data.
let queue = Promise.resolve();
module.exports = function pacedFetch(input, init) {
    const result = queue.then(async () => {
        await new Promise(resolve => setTimeout(resolve, 300));
        for (let attempt = 0;; attempt++) {
            const response = await fetch(input, init);
            if (response.status !== 429 || attempt === 3)
                return response;
            await response.text();
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    });
    queue = result.then(() => { }, () => { });
    return result;
};
