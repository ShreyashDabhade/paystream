import logging
from algokit_utils import AlgorandClient, OnSchemaBreak, OnUpdate
from pathlib import Path

logger = logging.getLogger(__name__)

def deploy() -> None:
    # 1. Init Client from environment (.env)
    algorand = AlgorandClient.from_environment()
    deployer = algorand.account.from_environment("DEPLOYER")
    algorand.set_signer(deployer.address, deployer.signer)

    # 2. Resolve the build artifact path
    # This assumes the build process (algokit compile) has run and placed the artifact here
    base_path = Path(__file__).parent.parent.parent / "artifacts" / "pay_stream"
    app_spec_path = base_path / "PayStream.arc56.json"

    if not app_spec_path.exists():
        logger.error(f"App Spec not found at {app_spec_path}. Did you run 'algokit project run build'?")
        return

    # 3. Deploy
    app_client = algorand.client.get_app_factory(
        app_spec=app_spec_path, 
        app_name="PayStream"
    ).deploy(
        on_schema_break=OnSchemaBreak.AppendApp,
        on_update=OnUpdate.AppendApp,
    )
    
    logger.info(f"Deployed PayStream Contract! App ID: {app_client.app_client.app_id}")