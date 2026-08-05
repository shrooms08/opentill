<?php
/**
 * Plugin Name:       OpenTill for WooCommerce
 * Plugin URI:        https://github.com/opentill/opentill
 * Description:       Accept Bitcoin payments through your own self-hosted OpenTill gateway (Tachi off-chain vaults). Customers pay on OpenTill's hosted checkout; orders complete via signed webhooks.
 * Version:           0.2.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            OpenTill
 * License:           MIT
 * Text Domain:       opentill-for-woocommerce
 *
 * Requires Plugins:  woocommerce
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'OPENTILL_WC_VERSION', '0.2.0' );
define( 'OPENTILL_WC_PLUGIN_FILE', __FILE__ );

add_action( 'plugins_loaded', 'opentill_wc_init', 11 );

/**
 * Register the gateway once WooCommerce is available.
 */
function opentill_wc_init() {
	if ( ! class_exists( 'WC_Payment_Gateway' ) ) {
		return; // WooCommerce inactive — do nothing, loudly doing nothing is worse.
	}

	require_once __DIR__ . '/includes/class-wc-gateway-opentill.php';

	add_filter(
		'woocommerce_payment_gateways',
		function ( $gateways ) {
			$gateways[] = 'WC_Gateway_OpenTill';
			return $gateways;
		}
	);
}

add_action( 'woocommerce_blocks_loaded', 'opentill_wc_blocks_support' );

/**
 * Register the block-based Cart/Checkout integration. Without this the method
 * is invisible on WooCommerce's default (block) checkout — only the classic
 * shortcode checkout picks it up from the gateway filter above. Guarded so it
 * no-ops on WooCommerce versions without the Blocks package.
 */
function opentill_wc_blocks_support() {
	if ( ! class_exists( 'Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType' ) ) {
		return;
	}

	require_once __DIR__ . '/includes/class-wc-gateway-opentill-blocks.php';

	add_action(
		'woocommerce_blocks_payment_method_type_registration',
		function ( $registry ) {
			$registry->register( new WC_Gateway_OpenTill_Blocks_Support() );
		}
	);
}
