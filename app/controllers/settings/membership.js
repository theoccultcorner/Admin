import Controller from '@ember/controller';
import envConfig from 'ghost-admin/config/environment';
import {action} from '@ember/object';
import {currencies, getCurrencyOptions, getSymbol} from 'ghost-admin/utils/currency';
import {inject as service} from '@ember/service';
import {task} from 'ember-concurrency-decorators';
import {tracked} from '@glimmer/tracking';

const CURRENCIES = currencies.map((currency) => {
    return {
        value: currency.isoCode.toLowerCase(),
        label: `${currency.isoCode} - ${currency.name}`,
        isoCode: currency.isoCode
    };
});

export default class MembersAccessController extends Controller {
    @service config;
    @service feature;
    @service membersUtils;
    @service settings;
    @service store;
    @service session;

    @tracked showLeavePortalModal = false;
    @tracked showLeaveRouteModal = false;
    @tracked showPortalSettings = false;
    @tracked showStripeConnect = false;
    @tracked showProductModal = false;

    @tracked product = null;
    @tracked products = null;
    @tracked productModel = null;
    @tracked paidSignupRedirect;
    @tracked freeSignupRedirect;
    @tracked welcomePageURL;
    @tracked stripeMonthlyAmount = 5;
    @tracked stripeYearlyAmount = 50;
    @tracked currency = 'usd';
    @tracked stripePlanError = '';

    @tracked portalPreviewUrl = '';

    portalPreviewGuid = Date.now().valueOf();

    queryParams = ['showPortalSettings'];

    get freeProduct() {
        return this.products?.find(product => product.type === 'free');
    }

    get paidProducts() {
        return this.products?.filter(product => product.type === 'paid');
    }

    get allCurrencies() {
        return getCurrencyOptions();
    }

    get siteUrl() {
        return this.config.get('blogUrl');
    }

    get selectedCurrency() {
        return CURRENCIES.findBy('value', this.currency);
    }

    get isConnectDisallowed() {
        const siteUrl = this.config.get('blogUrl');
        return envConfig.environment !== 'development' && !/^https:/.test(siteUrl);
    }

    get hasChangedPrices() {
        if (this.product) {
            const monthlyPrice = this.product.get('monthlyPrice');
            const yearlyPrice = this.product.get('yearlyPrice');

            if (monthlyPrice?.amount && parseFloat(this.stripeMonthlyAmount) !== (monthlyPrice.amount / 100)) {
                return true;
            }
            if (yearlyPrice?.amount && parseFloat(this.stripeYearlyAmount) !== (yearlyPrice.amount / 100)) {
                return true;
            }
        }

        return false;
    }

    @action
    setup() {
        this.fetchProducts.perform();
        this.updatePortalPreview();
    }

    leaveRoute(transition) {
        if (this.settings.get('hasDirtyAttributes') || this.hasChangedPrices) {
            transition.abort();
            this.leaveSettingsTransition = transition;
            this.showLeaveRouteModal = true;
        }
    }

    @action
    async confirmLeave() {
        this.settings.rollbackAttributes();
        this.resetPrices();
        this.leaveSettingsTransition.retry();
    }

    @action
    cancelLeave() {
        this.showLeaveRouteModal = false;
        this.leaveSettingsTransition = null;
    }

    @action
    async membersSubscriptionAccessChanged() {
        const oldValue = this.settings.changedAttributes().membersSignupAccess?.[0];

        if (oldValue === 'none') {
            // when saved value is 'none' the server won't inject the portal script
            // to work around that and show the expected portal preview we save and
            // force a refresh
            await this.switchFromNoneTask.perform();
        } else {
            this.updatePortalPreview();
        }
    }

    @action
    setStripePlansCurrency(event) {
        const newCurrency = event.value;
        this.currency = newCurrency;
    }

    @action
    setPaidSignupRedirect(url) {
        this.paidSignupRedirect = url;
    }

    @action
    setFreeSignupRedirect(url) {
        this.freeSignupRedirect = url;
    }

    @action
    setWelcomePageURL(url) {
        this.welcomePageURL = url;
    }

    @action
    validatePaidSignupRedirect() {
        return this._validateSignupRedirect(this.paidSignupRedirect, 'membersPaidSignupRedirect');
    }

    @action
    validateFreeSignupRedirect() {
        return this._validateSignupRedirect(this.freeSignupRedirect, 'membersFreeSignupRedirect');
    }

    @action
    validateWelcomePageURL() {
        const siteUrl = this.siteUrl;

        if (this.welcomePageURL === undefined) {
            // Not initialised
            return;
        }

        if (this.welcomePageURL.href.startsWith(siteUrl)) {
            const path = this.welcomePageURL.href.replace(siteUrl, '');
            this.freeProduct.welcomePageURL = path;
        } else {
            this.freeProduct.welcomePageURL = this.welcomePageURL.href;
        }
    }

    @action
    validateStripePlans({updatePortalPreview = true} = {}) {
        this.stripePlanError = undefined;

        try {
            const yearlyAmount = this.stripeYearlyAmount;
            const monthlyAmount = this.stripeMonthlyAmount;
            const symbol = getSymbol(this.currency);
            if (!yearlyAmount || yearlyAmount < 1 || !monthlyAmount || monthlyAmount < 1) {
                throw new TypeError(`Subscription amount must be at least ${symbol}1.00`);
            }

            if (updatePortalPreview) {
                this.updatePortalPreview();
            }
        } catch (err) {
            this.stripePlanError = err.message;
        }
    }

    @action
    openStripeConnect() {
        this.stripeEnabledOnOpen = this.membersUtils.isStripeEnabled;
        this.showStripeConnect = true;
    }

    @action
    async closeStripeConnect() {
        if (this.stripeEnabledOnOpen !== this.membersUtils.isStripeEnabled) {
            await this.saveSettingsTask.perform({forceRefresh: true});
        }
        this.showStripeConnect = false;
    }

    @action
    async openEditProduct(product) {
        this.productModel = product;
        this.showProductModal = true;
    }

    @action
    async openNewProduct() {
        this.productModel = this.store.createRecord('product');
        this.showProductModal = true;
    }

    @action
    closeProductModal() {
        this.showProductModal = false;
    }

    @action
    openPortalSettings() {
        this.saveSettingsTask.perform();
        this.showPortalSettings = true;
    }

    @action
    closePortalSettings() {
        const changedAttributes = this.settings.changedAttributes();
        if (changedAttributes && Object.keys(changedAttributes).length > 0) {
            this.showLeavePortalModal = true;
        } else {
            this.showPortalSettings = false;
            this.updatePortalPreview();
        }
    }

    @action
    async confirmClosePortalSettings() {
        this.settings.rollbackAttributes();
        this.showPortalSettings = false;
        this.showLeavePortalModal = false;
        this.updatePortalPreview();
    }

    @action
    cancelClosePortalSettings() {
        this.showLeavePortalModal = false;
    }

    @action
    updatePortalPreview({forceRefresh} = {forceRefresh: false}) {
        // TODO: can these be worked out from settings in membersUtils?
        const monthlyPrice = this.stripeMonthlyAmount * 100;
        const yearlyPrice = this.stripeYearlyAmount * 100;
        let portalPlans = this.settings.get('portalPlans') || [];

        let isMonthlyChecked = portalPlans.includes('monthly');
        let isYearlyChecked = portalPlans.includes('yearly');

        const newUrl = new URL(this.membersUtils.getPortalPreviewUrl({
            button: false,
            monthlyPrice,
            yearlyPrice,
            currency: this.currency,
            isMonthlyChecked,
            isYearlyChecked,
            portalPlans: null
        }));

        if (forceRefresh) {
            this.portalPreviewGuid = Date.now().valueOf();
        }
        newUrl.searchParams.set('v', this.portalPreviewGuid);

        this.portalPreviewUrl = newUrl;
    }

    @action
    portalPreviewInserted(iframe) {
        this.portalPreviewIframe = iframe;

        if (!this.portalMessageListener) {
            this.portalMessageListener = (event) => {
                // don't resize membership portal preview when events fire in customize portal modal
                if (this.showPortalSettings) {
                    return;
                }

                const resizeEvents = ['portal-ready', 'portal-preview-updated'];
                if (resizeEvents.includes(event.data.type) && event.data.payload?.height && this.portalPreviewIframe?.parentNode) {
                    this.portalPreviewIframe.parentNode.style.height = `${event.data.payload.height}px`;
                }
            };

            window.addEventListener('message', this.portalMessageListener, true);
        }
    }

    @action
    portalPreviewDestroyed() {
        this.portalPreviewIframe = null;

        if (this.portalMessageListener) {
            window.removeEventListener('message', this.portalMessageListener);
        }
    }

    @action
    confirmProductSave() {
        this.updatePortalPreview({forceRefresh: true});
        return this.fetchProducts.perform();
    }

    @task
    *switchFromNoneTask() {
        return yield this.saveSettingsTask.perform({forceRefresh: true});
    }

    setupPortalProduct(product) {
        if (product) {
            const monthlyPrice = product.get('monthlyPrice');
            const yearlyPrice = product.get('yearlyPrice');
            if (monthlyPrice && monthlyPrice.amount) {
                this.stripeMonthlyAmount = (monthlyPrice.amount / 100);
                this.currency = monthlyPrice.currency;
            }
            if (yearlyPrice && yearlyPrice.amount) {
                this.stripeYearlyAmount = (yearlyPrice.amount / 100);
            }
            this.updatePortalPreview();
        }
    }

    @task({drop: true})
    *fetchProducts() {
        this.products = yield this.store.query('product', {
            include: 'monthly_price,yearly_price,benefits'
        });
        this.product = this.paidProducts.firstObject;
        this.setupPortalProduct(this.product);
    }

    @task({drop: true})
    *saveSettingsTask(options) {
        if (!this.feature.get('multipleProducts')) {
            yield this.validateStripePlans({updatePortalPreview: false});

            if (this.stripePlanError) {
                return;
            }

            if (this.settings.get('errors').length !== 0) {
                return;
            }

            yield this.saveProduct();
            const result = yield this.settings.save();

            this.updatePortalPreview(options);

            return result;
        } else {
            if (this.settings.get('errors').length !== 0) {
                return;
            }
            // When no filer is selected in `Specific tier(s)` option
            if (!this.settings.get('defaultContentVisibility')) {
                return;
            }
            const result = yield this.settings.save();
            yield this.freeProduct.save();
            this.updatePortalPreview(options);
            return result;
        }
    }

    async saveProduct() {
        const isStripeConnected = this.settings.get('stripeConnectAccountId');
        if (this.product && isStripeConnected) {
            const monthlyAmount = this.stripeMonthlyAmount * 100;
            const yearlyAmount = this.stripeYearlyAmount * 100;

            this.product.set('monthlyPrice', {
                nickname: 'Monthly',
                amount: monthlyAmount,
                active: true,
                currency: this.currency,
                interval: 'month',
                type: 'recurring'
            });
            this.product.set('yearlyPrice', {
                nickname: 'Yearly',
                amount: yearlyAmount,
                active: true,
                currency: this.currency,
                interval: 'year',
                type: 'recurring'
            });

            const savedProduct = await this.product.save();
            return savedProduct;
        }
    }

    resetPrices() {
        const monthlyPrice = this.product.get('monthlyPrice');
        const yearlyPrice = this.product.get('yearlyPrice');

        this.stripeMonthlyAmount = monthlyPrice ? (monthlyPrice.amount / 100) : 5;
        this.stripeYearlyAmount = yearlyPrice ? (yearlyPrice.amount / 100) : 50;
    }

    reset() {
        this.showLeaveRouteModal = false;
        this.showLeavePortalModal = false;
        this.showPortalSettings = false;
    }

    _validateSignupRedirect(url, type) {
        const siteUrl = this.config.get('blogUrl');
        let errMessage = `Please enter a valid URL`;
        this.settings.get('errors').remove(type);
        this.settings.get('hasValidated').removeObject(type);

        if (url === null) {
            this.settings.get('errors').add(type, errMessage);
            this.settings.get('hasValidated').pushObject(type);
            return false;
        }

        if (url === undefined) {
            // Not initialised
            return;
        }

        if (url.href.startsWith(siteUrl)) {
            const path = url.href.replace(siteUrl, '');
            this.settings.set(type, path);
        } else {
            this.settings.set(type, url.href);
        }
    }
}
