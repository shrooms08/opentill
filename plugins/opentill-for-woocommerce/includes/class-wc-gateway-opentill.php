<?php
/**
 * OpenTill payment gateway for WooCommerce.
 *
 * Flow: process_payment creates an invoice on the merchant's own OpenTill
 * gateway and redirects the customer to its hosted checkout. Order state then
 * follows OpenTill's HMAC-signed webhooks — never the customer's browser.
 *
 * @package OpenTill
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * WC_Gateway_OpenTill
 */
class WC_Gateway_OpenTill extends WC_Payment_Gateway {

	/**
	 * Set up gateway id, settings, and hooks.
	 */
	public function __construct() {
		$this->id                 = 'opentill';
		$this->method_title       = __( 'OpenTill (Bitcoin)', 'opentill-for-woocommerce' );
		$this->method_description = __( 'Self-hosted Bitcoin payments via your own OpenTill gateway. Customers pay sats on OpenTill\'s hosted checkout page.', 'opentill-for-woocommerce' );
		$this->has_fields         = false;

		$this->init_form_fields();
		$this->init_settings();

		$this->title       = $this->get_option( 'title' );
		$this->description = $this->get_option( 'description' );

		add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, array( $this, 'process_admin_options' ) );
		// Webhook endpoint: {site}/?wc-api=opentill (or /wc-api/opentill with pretty permalinks).
		add_action( 'woocommerce_api_opentill', array( $this, 'handle_webhook' ) );
	}

	/**
	 * Admin settings.
	 */
	public function init_form_fields() {
		$this->form_fields = array(
			'enabled'        => array(
				'title'   => __( 'Enable/Disable', 'opentill-for-woocommerce' ),
				'type'    => 'checkbox',
				'label'   => __( 'Enable OpenTill payments', 'opentill-for-woocommerce' ),
				'default' => 'no',
			),
			'title'          => array(
				'title'       => __( 'Title', 'opentill-for-woocommerce' ),
				'type'        => 'text',
				'description' => __( 'Shown to the customer at checkout.', 'opentill-for-woocommerce' ),
				'default'     => __( 'Bitcoin (OpenTill)', 'opentill-for-woocommerce' ),
				'desc_tip'    => true,
			),
			'description'    => array(
				'title'       => __( 'Description', 'opentill-for-woocommerce' ),
				'type'        => 'textarea',
				'description' => __( 'Shown under the payment method at checkout.', 'opentill-for-woocommerce' ),
				'default'     => __( 'Pay in sats. You will be redirected to a payment page with a QR code.', 'opentill-for-woocommerce' ),
				'desc_tip'    => true,
			),
			'gateway_url'         => array(
				'title'       => __( 'Gateway URL', 'opentill-for-woocommerce' ),
				'type'        => 'text',
				'description' => __( 'Base URL your WordPress server uses to reach the OpenTill gateway for server-to-server API calls, e.g. https://pay.example.com — no trailing slash needed.', 'opentill-for-woocommerce' ),
				'default'     => '',
			),
			'public_checkout_url' => array(
				'title'       => __( 'Public checkout URL (optional)', 'opentill-for-woocommerce' ),
				'type'        => 'text',
				'description' => __( 'Only used for the customer redirect to the hosted checkout. Leave blank to reuse the Gateway URL. Set this when the browser reaches the gateway at a different host than your server does — e.g. Docker: server calls http://host.docker.internal:8080, but the browser needs http://localhost:8080.', 'opentill-for-woocommerce' ),
				'default'     => '',
			),
			'api_key'        => array(
				'title'       => __( 'API key', 'opentill-for-woocommerce' ),
				'type'        => 'password',
				'description' => __( 'OPENTILL_API_KEY from your gateway. Stored in WordPress options; sent only server-to-server.', 'opentill-for-woocommerce' ),
				'default'     => '',
			),
			'webhook_secret'      => array(
				'title'       => __( 'Webhook secret', 'opentill-for-woocommerce' ),
				'type'        => 'password',
				'description' => __( 'OPENTILL_WEBHOOK_SECRET from your gateway. Used to verify the X-OpenTill-Signature header.', 'opentill-for-woocommerce' ),
				'default'     => '',
			),
			'webhook_base_url'    => array(
				'title'       => __( 'Webhook base URL (optional)', 'opentill-for-woocommerce' ),
				'type'        => 'text',
				'description' => __( 'Only used when building the webhook URL sent to the gateway. Leave blank to use this site\'s home URL. Set this when the gateway must reach WordPress at a different host — e.g. Docker: http://host.docker.internal:8081. WordPress\'s port must be reachable from the gateway container.', 'opentill-for-woocommerce' ),
				'default'     => '',
			),
			'sats_per_unit'  => array(
				'title'       => __( 'Sats per currency unit', 'opentill-for-woocommerce' ),
				'type'        => 'number',
				'description' => __( 'Fixed conversion: order total × this = amount in sats. Example: 1000 means a 21.00 order charges 21000 sats. Live BTC/fiat conversion is deliberately out of scope for this version — set this to your chosen fixed rate, or price your products in sats directly with a rate of 1.', 'opentill-for-woocommerce' ),
				'default'     => '1',
			),
		);
	}

	/**
	 * Gateway base URL from settings, normalized.
	 *
	 * @return string
	 */
	private function gateway_url() {
		return untrailingslashit( esc_url_raw( trim( $this->get_option( 'gateway_url' ) ) ) );
	}

	/**
	 * Base URL the customer's browser is redirected to for the hosted checkout.
	 * Falls back to the server-side Gateway URL when unset (current behavior).
	 *
	 * @return string
	 */
	private function public_checkout_url() {
		$custom = untrailingslashit( esc_url_raw( trim( $this->get_option( 'public_checkout_url' ) ) ) );
		return '' !== $custom ? $custom : $this->gateway_url();
	}

	/**
	 * Webhook URL passed to the gateway on invoice creation. Defaults to WP's
	 * own wc-api URL (home_url based). When a Webhook base URL is set, the same
	 * wc-api path is rebased onto that host — so the gateway container can reach
	 * WordPress even when its home URL is not routable from the container.
	 *
	 * @return string
	 */
	private function webhook_url() {
		$default = WC()->api_request_url( 'opentill' );
		$base    = untrailingslashit( esc_url_raw( trim( $this->get_option( 'webhook_base_url' ) ) ) );

		if ( '' === $base ) {
			return $default; // Unchanged default: home_url() based.
		}

		// Preserve the site's permalink style (?wc-api= vs /wc-api/) by swapping
		// only the home origin for the custom base.
		$home = untrailingslashit( home_url() );
		if ( '' !== $home && 0 === strpos( $default, $home ) ) {
			return $base . substr( $default, strlen( $home ) );
		}

		return $base . '/?wc-api=opentill';
	}

	/**
	 * Convert the order total into whole sats via the fixed rate.
	 *
	 * @param WC_Order $order Order.
	 * @return int
	 */
	private function order_total_in_sats( $order ) {
		$rate = (float) $this->get_option( 'sats_per_unit', '1' );
		return (int) round( (float) $order->get_total() * $rate );
	}

	/**
	 * Create the OpenTill invoice and send the customer to the hosted checkout.
	 *
	 * @param int $order_id WooCommerce order id.
	 * @return array
	 */
	public function process_payment( $order_id ) {
		$order = wc_get_order( $order_id );
		$sats  = $this->order_total_in_sats( $order );

		if ( '' === $this->gateway_url() || '' === $this->get_option( 'api_key' ) ) {
			wc_add_notice( __( 'OpenTill is not configured yet — set the Gateway URL and API key.', 'opentill-for-woocommerce' ), 'error' );
			return array( 'result' => 'failure' );
		}
		if ( $sats <= 0 ) {
			wc_add_notice( __( 'This order converts to zero sats — check the "sats per currency unit" setting.', 'opentill-for-woocommerce' ), 'error' );
			return array( 'result' => 'failure' );
		}

		$response = wp_remote_post(
			$this->gateway_url() . '/api/invoices',
			array(
				'timeout' => 15,
				'headers' => array(
					'Authorization' => 'Bearer ' . $this->get_option( 'api_key' ),
					'Content-Type'  => 'application/json',
				),
				'body'    => wp_json_encode(
					array(
						'amountSats' => (string) $sats,
						'memo'       => get_bloginfo( 'name' ) . ' — ' . sprintf( __( 'order #%s', 'opentill-for-woocommerce' ), $order->get_order_number() ),
						'orderId'    => (string) $order->get_id(),
						'webhookUrl' => $this->webhook_url(),
						'returnUrl'  => $this->get_return_url( $order ),
					)
				),
			)
		);

		if ( is_wp_error( $response ) ) {
			wc_add_notice(
				sprintf(
					/* translators: %s: transport error message */
					__( 'Could not reach the OpenTill gateway: %s', 'opentill-for-woocommerce' ),
					esc_html( $response->get_error_message() )
				),
				'error'
			);
			return array( 'result' => 'failure' );
		}

		$code = (int) wp_remote_retrieve_response_code( $response );
		$body = json_decode( wp_remote_retrieve_body( $response ), true );

		if ( 201 !== $code || ! is_array( $body ) || empty( $body['id'] ) ) {
			$message = is_array( $body ) && ! empty( $body['message'] ) ? $body['message'] : sprintf( 'HTTP %d', $code );
			wc_add_notice(
				sprintf(
					/* translators: %s: gateway error message */
					__( 'OpenTill rejected the payment request: %s', 'opentill-for-woocommerce' ),
					esc_html( $message )
				),
				'error'
			);
			return array( 'result' => 'failure' );
		}

		$invoice_id = sanitize_text_field( $body['id'] );
		$order->update_meta_data( '_opentill_invoice_id', $invoice_id );
		$order->update_status( 'pending', __( 'Awaiting Bitcoin payment on OpenTill.', 'opentill-for-woocommerce' ) );
		$order->save();

		if ( isset( WC()->cart ) ) {
			WC()->cart->empty_cart();
		}

		return array(
			'result'   => 'success',
			'redirect' => $this->public_checkout_url() . '/pay/' . rawurlencode( $invoice_id ),
		);
	}

	/**
	 * Webhook receiver: verify HMAC over the raw body, transition the order.
	 * Idempotent — re-delivered webhooks never double-transition. Responds 200
	 * fast; unknown orders are ACKed so the gateway stops retrying.
	 */
	public function handle_webhook() {
		$raw       = file_get_contents( 'php://input' );
		$signature = isset( $_SERVER['HTTP_X_OPENTILL_SIGNATURE'] )
			? sanitize_text_field( wp_unslash( $_SERVER['HTTP_X_OPENTILL_SIGNATURE'] ) )
			: '';
		$secret    = (string) $this->get_option( 'webhook_secret' );

		if ( '' === $secret || ! hash_equals( hash_hmac( 'sha256', $raw, $secret ), $signature ) ) {
			status_header( 401 );
			exit;
		}

		$payload = json_decode( $raw, true );
		if ( ! is_array( $payload ) || empty( $payload['orderId'] ) || empty( $payload['status'] ) ) {
			status_header( 400 );
			exit;
		}

		$order = wc_get_order( absint( $payload['orderId'] ) );
		if ( ! $order ) {
			status_header( 200 ); // Not ours (or deleted) — ACK so retries stop.
			exit;
		}

		$invoice_id = isset( $payload['invoiceId'] ) ? sanitize_text_field( $payload['invoiceId'] ) : '';
		if ( $order->get_meta( '_opentill_invoice_id' ) !== $invoice_id ) {
			status_header( 200 ); // Stale or mismatched invoice — ignore, ACK.
			exit;
		}

		switch ( (string) $payload['status'] ) {
			case 'confirmed':
				if ( ! $order->is_paid() ) {
					$order->payment_complete( $invoice_id );
					$order->add_order_note(
						sprintf(
							/* translators: 1: sats amount, 2: invoice id */
							__( 'OpenTill payment confirmed: %1$s sats (invoice %2$s).', 'opentill-for-woocommerce' ),
							isset( $payload['amountPaidSats'] ) ? sanitize_text_field( $payload['amountPaidSats'] ) : '?',
							$invoice_id
						)
					);
				}
				break;

			case 'expired':
				if ( $order->has_status( 'pending' ) ) {
					$order->update_status( 'cancelled', __( 'OpenTill invoice expired without payment.', 'opentill-for-woocommerce' ) );
				}
				break;

			case 'refunded':
				if ( ! $order->has_status( 'refunded' ) ) {
					$order->update_status( 'refunded', __( 'Payment refunded via the OpenTill dashboard.', 'opentill-for-woocommerce' ) );
				}
				break;

			// Other statuses (paid, underpaid, refund_pending) are informational.
			default:
				$order->add_order_note(
					sprintf(
						/* translators: %s: OpenTill invoice status */
						__( 'OpenTill status update: %s.', 'opentill-for-woocommerce' ),
						sanitize_text_field( $payload['status'] )
					)
				);
		}

		status_header( 200 );
		header( 'Content-Type: application/json' );
		echo '{}';
		exit;
	}
}
