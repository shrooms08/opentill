<?php
/**
 * OpenTill payment method integration for WooCommerce Blocks (the default
 * block-based Cart & Checkout). Mirrors the classic gateway's title/description
 * from the same settings, so both checkouts show identical copy. All money
 * logic still lives in WC_Gateway_OpenTill::process_payment — Blocks calls the
 * classic gateway's process_payment under the hood, so nothing here touches
 * invoices, redirects, or webhooks.
 *
 * @package OpenTill
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;

/**
 * WC_Gateway_OpenTill_Blocks_Support
 */
final class WC_Gateway_OpenTill_Blocks_Support extends AbstractPaymentMethodType {

	/**
	 * Payment method id — must match WC_Gateway_OpenTill::$id.
	 *
	 * @var string
	 */
	protected $name = 'opentill';

	// NOTE: no $settings redeclaration here — the parent already declares
	// `protected $settings = [];`, and redeclaring it with narrower (private)
	// visibility is a PHP fatal on activation. initialize() assigns to the
	// inherited property.

	/**
	 * Load settings from the classic gateway's option row.
	 */
	public function initialize() {
		$this->settings = get_option( 'woocommerce_opentill_settings', array() );
	}

	/**
	 * Only offer the method in block checkout when the gateway is enabled.
	 *
	 * @return bool
	 */
	public function is_active() {
		return ! empty( $this->settings['enabled'] ) && 'yes' === $this->settings['enabled'];
	}

	/**
	 * Register the (build-free) client script and return its handle.
	 *
	 * @return string[]
	 */
	public function get_payment_method_script_handles() {
		$handle = 'wc-opentill-blocks';

		wp_register_script(
			$handle,
			plugins_url( 'assets/js/blocks.js', OPENTILL_WC_PLUGIN_FILE ),
			array( 'wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities', 'wp-i18n' ),
			defined( 'OPENTILL_WC_VERSION' ) ? OPENTILL_WC_VERSION : '0.2.0',
			true
		);

		if ( function_exists( 'wp_set_script_translations' ) ) {
			wp_set_script_translations( $handle, 'opentill-for-woocommerce' );
		}

		return array( $handle );
	}

	/**
	 * Data handed to the client script (via wc.wcSettings 'opentill_data').
	 *
	 * @return array
	 */
	public function get_payment_method_data() {
		return array(
			'title'       => isset( $this->settings['title'] ) && '' !== $this->settings['title']
				? $this->settings['title']
				: __( 'Bitcoin (OpenTill)', 'opentill-for-woocommerce' ),
			'description' => isset( $this->settings['description'] ) ? $this->settings['description'] : '',
			'supports'    => array( 'products' ),
		);
	}
}
